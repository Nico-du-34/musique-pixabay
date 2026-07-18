const { chromium } = require("playwright");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const pLimit = require("p-limit").default;
const cliProgress = require("cli-progress");


// ==============================
// CONFIGURATION
// ==============================

const CONFIG = {

    pages: 12775,

    baseUrl:
    "https://pixabay.com/fr/music/search/?order=ec&page=",

    downloadFolder:
    "./library/Musique",

    indexFile:
    "./library/index.json",


    githubUser:
    "Nico-du-34",

    githubRepo:
    "musique-pixabay",


    concurrency: 3,

    delay: 3000,

    // networkidle bloque souvent sur Pixabay (analytics/ads)
    navTimeout: 45000,

    // Chrome réel évite le challenge Cloudflare (Chromium Playwright = 403)
    headless: true,

    cfWaitMs: 45000

};


// ==============================
// INIT
// ==============================


const limit =
pLimit(CONFIG.concurrency);


async function sleep(ms){

    const step = 200;
    let left = ms;

    while(
        left > 0
    ){

        if(
            stopping
        ){
            return;
        }

        const chunk =
        Math.min(step, left);

        await new Promise(
            r => setTimeout(r, chunk)
        );

        left -= chunk;

    }

}


fs.ensureDirSync(
    CONFIG.downloadFolder
);


let index = {

    generated_at:
    new Date(),

    total: 0,

    tracks: []

};



if(
    fs.existsSync(CONFIG.indexFile)
){

    try{

        const raw =
        fs.readFileSync(
            CONFIG.indexFile,
            "utf8"
        ).trim();

        if(raw){

            index =
            JSON.parse(raw);

        }
        else{

            console.log(
                "Index vide, démarrage avec index par défaut"
            );

        }

    }
    catch(e){

        console.log(
            "Index JSON invalide, démarrage avec index par défaut"
        );

    }

}


const stats = {
    ok: 0,
    skip: 0,
    fail: 0
};


let stopping = false;

let activeBar = null;

let browserRef = null;


// ==============================
// UTILITAIRES
// ==============================


function saveIndex(){

    fs.writeJsonSync(
        CONFIG.indexFile,
        index,
        {
            spaces: 2
        }
    );

}



function stopActiveBar(){

    if(
        !activeBar
    ){
        return;
    }

    try{

        activeBar.stop();

    }
    catch(_){}

    activeBar = null;

}



function isAbortError(err){

    const msg =
    String(err?.message || err || "");

    return (
        stopping
        ||
        /Target (page|context|browser) has been closed|browser has been closed|Connection closed|Protocol error/i
        .test(msg)
    );

}



function requestStop(signal){

    if(
        stopping
    ){
        return;
    }

    stopping = true;

    stopActiveBar();

    process.stdout.write(
        `\n→ Arrêt demandé (${signal}), finalisation…\n`
    );

}



function clean(text){

    return text
    ?.replace(/[<>:"\/\\|?*]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase()
    ||
    "unknown";

}



function hashFile(file){

    const buffer =
    fs.readFileSync(file);


    return crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex");

}



function categoryFromTags(tags){


    const txt =
    tags.join(" ").toLowerCase();



    const categories = {


        Cinematic: [
            "cinematic",
            "epic",
            "movie",
            "orchestra"
        ],


        Ambient: [
            "ambient",
            "relax",
            "nature",
            "calm"
        ],


        Gaming: [
            "game",
            "battle",
            "fantasy",
            "rpg"
        ],


        Electronic: [
            "electronic",
            "synth",
            "techno",
            "dance"
        ],


        Horror: [
            "dark",
            "horror",
            "scary"
        ]

    };



    for(
        const cat in categories
    ){

        if(
            categories[cat]
            .some(
                x => txt.includes(x)
            )
        ){

            return cat;

        }

    }


    return "Unknown";

}



function githubUrl(file){


    const relative =
    file
    .replace("./library/", "")
    .replaceAll("\\", "/");


    return `https://raw.githubusercontent.com/${CONFIG.githubUser}/${CONFIG.githubRepo}/main/${relative}`;

}



function isTrackUrl(url){

    try{

        const u = new URL(url);

        // /fr/music/titre-123456/  — pas /music/search/
        return (
            /\/music\/[^/]+-\d+\/?$/.test(u.pathname)
            &&
            !u.pathname.includes("/search/")
        );

    }
    catch{

        return false;

    }

}



function makeBar(label, total){

    const bar = new cliProgress.SingleBar(
        {
            format:
            `${label} |{bar}| {percentage}% | {value}/{total} | {status}`,
            barCompleteChar: "█",
            barIncompleteChar: "░",
            hideCursor: true,
            clearOnComplete: false,
            stopOnComplete: true
        },
        cliProgress.Presets.shades_classic
    );

    bar.start(Math.max(total, 1), 0, { status: "..." });

    activeBar = bar;

    return bar;

}



async function waitForCloudflare(page, label){

    const start = Date.now();

    while(
        Date.now() - start < CONFIG.cfWaitMs
    ){

        if(
            stopping
        ){
            throw new Error("arrêt demandé");
        }

        const title =
        await page.title();

        if(
            !/just a moment|attention required|security verification/i
            .test(title)
        ){

            return;
        }

        process.stdout.write(
            `\r→ ${label}: challenge Cloudflare… ${Math.round((Date.now() - start) / 1000)}s   `
        );

        await sleep(1000);

    }

    throw new Error(
        "Cloudflare non résolu (timeout)"
    );

}



async function gotoSafe(page, url, label){

    process.stdout.write(`\n→ ${label}: navigation...\n`);

    await page.goto(
        url,
        {
            waitUntil: "domcontentloaded",
            timeout: CONFIG.navTimeout
        }
    );

    await waitForCloudflare(page, label);

}



// ==============================
// DOWNLOAD
// ==============================


async function download(url, file){


    if(
        stopping
    ){
        return false;
    }


    if(
        fs.existsSync(file)
    ){

        return false;

    }


    const response =
    await axios({

        url,

        method: "GET",

        responseType: "stream",

        timeout: 120000

    });



    await new Promise(
    (resolve, reject) => {


        const stream =
        fs.createWriteStream(file);


        response.data.pipe(stream);


        stream.on(
            "finish",
            resolve
        );


        stream.on(
            "error",
            reject
        );


    });


    return true;

}



// ==============================
// SCRAPE MUSIQUE
// ==============================


async function scrapeMusic(
    url,
    context,
    onDone
){


    if(
        stopping
    ){
        return;
    }


    const page =
    await context.newPage();



    try{


        await page.goto(
            url,
            {
                waitUntil: "domcontentloaded",
                timeout: CONFIG.navTimeout
            }
        );

        if(
            stopping
        ){
            return;
        }

        await waitForCloudflare(page, "piste");


        await sleep(800);

        if(
            stopping
        ){
            return;
        }



        const data =
        await page.evaluate(() => {


            const html =
            document.documentElement.outerHTML;


            let audio = null;
            let title = "unknown";


            try{

                const lds =
                [...document.querySelectorAll(
                    'script[type="application/ld+json"]'
                )]
                .map(
                    s => {
                        try{
                            return JSON.parse(s.textContent);
                        }
                        catch{
                            return null;
                        }
                    }
                )
                .filter(Boolean);


                const audioObj =
                lds.find(
                    j =>
                    j["@type"] === "AudioObject"
                    ||
                    j.contentUrl
                );


                if(
                    audioObj
                ){

                    audio =
                    audioObj.contentUrl
                    ||
                    null;

                    if(
                        audioObj.name
                    ){

                        title =
                        String(audioObj.name)
                        .replace(
                            /\s*\|\s*Musique.*/i,
                            ""
                        )
                        .trim();

                    }

                }

            }
            catch(_){}


            if(
                !audio
            ){

                audio =
                html.match(
                    /https?:\/\/cdn\.pixabay\.com\/download\/audio\/[^"'\\\s]+/
                )?.[0]
                ||
                html.match(
                    /https?:\/\/cdn\.pixabay\.com\/audio\/[^"'\\\s]+\.mp3[^"'\\\s]*/
                )?.[0]
                ||
                document.querySelector("audio")
                ?.src
                ||
                null;

            }


            if(
                title === "unknown"
            ){

                title =
                document.querySelector(
                    'meta[property="og:title"]'
                )
                ?.content
                ?.replace(
                    /\s*\|\s*Musique.*/i,
                    ""
                )
                .trim()
                ||
                document.title
                ?.replace(
                    /\s*\|\s*Musique.*$/i,
                    ""
                )
                .replace(
                    /\s*-\s*Pixabay.*$/i,
                    ""
                )
                .trim()
                ||
                "unknown";

            }


            let filenameHint = null;

            try{

                if(
                    audio
                ){

                    const u =
                    new URL(audio);

                    filenameHint =
                    u.searchParams.get(
                        "filename"
                    );

                }

            }
            catch(_){}



            const tags =
            [...document.querySelectorAll(
                "a[href*='/music/search/']"
            )]
            .map(
                x => x.innerText.trim()
            )
            .filter(
                x =>
                x
                &&
                x.length > 1
                &&
                x.length < 40
            );



            return {

                title,

                audio,

                filenameHint,

                tags

            };


        });



        if(
            !data.audio
        ){

            stats.skip++;
            onDone?.("skip", data.title);
            return;

        }



        const category =
        categoryFromTags(
            data.tags
        );



        const filename =
        clean(
            data.filenameHint
            ?.replace(/\.mp3$/i, "")
            ||
            data.title
        )
        + ".mp3";



        const folder =
        path.join(
            CONFIG.downloadFolder,
            category
        );


        await fs.ensureDir(
            folder
        );



        const file =
        path.join(
            folder,
            filename
        );



        const downloaded =
        await download(
            data.audio,
            file
        );


        if(
            stopping
        ){
            return;
        }


        const sha =
        hashFile(file);



        if(
            index.tracks
            .some(
                t => t.hash === sha || t.file?.sha256 === sha
            )
        ){

            stats.skip++;
            onDone?.("dup", data.title);
            return;

        }



        const relative =
        file
        .replace("./library/", "");



        index.tracks.push({

            id:
            crypto.randomUUID(),


            title:
            data.title,


            filename,


            category,


            tags:
            data.tags,


            source: {

                pixabay: url,

                download:
                data.audio

            },


            repository: {

                github:
                githubUrl(file)

            },


            file: {

                path:
                relative,

                sha256:
                sha

            },


            created_at:
            new Date()


        });



        index.total =
        index.tracks.length;



        fs.writeJsonSync(
            CONFIG.indexFile,
            index,
            {
                spaces: 2
            }
        );


        stats.ok++;
        onDone?.(
            downloaded ? "ok" : "cached",
            data.title
        );



    }
    catch(e){

        if(
            isAbortError(e)
        ){
            onDone?.(
                "stop",
                "arrêt"
            );
            return;
        }

        stats.fail++;
        onDone?.(
            "err",
            e.message?.slice(0, 60) || "erreur"
        );

    }
    finally{

        try{

            await page.close();

        }
        catch(_){}

    }


}




// ==============================
// SCRAPE PAGE
// ==============================


async function scrapePage(
    num,
    context
){


    if(
        stopping
    ){
        return;
    }


    console.log(
        `\n========== PAGE ${num}/${CONFIG.pages} ==========`
    );


    const page =
    await context.newPage();



    try{

        await gotoSafe(
            page,
            CONFIG.baseUrl + num,
            `Page ${num}`
        );


        if(
            stopping
        ){
            return;
        }


        // laisse le listing se peupler
        await page.waitForSelector(
            "a[href*='/music/']",
            { timeout: 20000 }
        ).catch(() => null);

        await sleep(1500);


        if(
            stopping
        ){
            return;
        }


        const links =
        await page.evaluate(() => {


            return [
                ...document.querySelectorAll(
                    "a"
                )
            ]
            .map(
                a => a.href
            )
            .filter(
                Boolean
            );


        });



        const unique =
        [...new Set(
            links.filter(isTrackUrl)
        )];


        console.log(
            `→ Page ${num}: ${unique.length} pistes trouvées (${links.length} liens bruts)`
        );
        console.log(
            `→ Téléchargement (×${CONFIG.concurrency})…`
        );


        if(
            unique.length === 0
        ){

            console.log(
                `⚠ Page ${num}: aucune piste — Cloudflare ou page vide ?`
            );
            return;

        }


        const bar =
        makeBar(
            `DL p${num}`,
            unique.length
        );

        let done = 0;


        const tasks =
        unique.map(
            link =>
            limit(
                async () => {

                    if(
                        stopping
                    ){
                        return;
                    }

                    await scrapeMusic(
                        link,
                        context,
                        (status, title) => {

                            done++;
                            bar.update(
                                done,
                                {
                                    status:
                                    `${status} ${String(title || "").slice(0, 28)}`
                                }
                            );

                        }
                    );

                }
            )
        );


        await Promise.all(tasks);

        stopActiveBar();


        if(
            stopping
        ){
            return;
        }


        console.log(
            `✓ Page ${num} terminée — ok:${stats.ok} skip:${stats.skip} fail:${stats.fail} | index:${index.total}`
        );


    }
    catch(e){

        if(
            isAbortError(e)
        ){
            return;
        }

        console.log(
            `✗ Page ${num} échouée:`,
            e.message
        );

    }
    finally{

        try{

            await page.close();

        }
        catch(_){}

    }


}



// ==============================
// START
// ==============================


process.on(
    "SIGINT",
    () => requestStop("SIGINT")
);

process.on(
    "SIGTERM",
    () => requestStop("SIGTERM")
);


(async () => {


console.log(
    "Pixabay scraper — démarrage"
);
console.log(
    `Pages: ${CONFIG.pages} | concurrence: ${CONFIG.concurrency} | délai: ${CONFIG.delay}ms | headless: ${CONFIG.headless}`
);
console.log(
    `Index actuel: ${index.total} pistes`
);


const browser =
await chromium.launch({

    headless: CONFIG.headless,

    channel: "chrome",

    args: [
        "--disable-blink-features=AutomationControlled"
    ]

});

browserRef = browser;


const context =
await browser.newContext({

    userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",

    locale: "fr-FR",

    viewport: {
        width: 1365,
        height: 900
    }

});


await context.addInitScript(() => {

    Object.defineProperty(
        navigator,
        "webdriver",
        {
            get: () => undefined
        }
    );

});



try{

for(
let i = 1;
i <= CONFIG.pages;
i++
){

    if(
        stopping
    ){
        break;
    }

    await scrapePage(
        i,
        context
    );


    if(
        stopping
    ){
        break;
    }


    console.log(
        `Progression globale: ${i}/${CONFIG.pages} pages | ok:${stats.ok} skip:${stats.skip} fail:${stats.fail}`
    );


    if(
        i < CONFIG.pages
    ){

        process.stdout.write(
            `\n… pause ${CONFIG.delay}ms avant page suivante\n`
        );

        await sleep(
            CONFIG.delay
        );

    }

}

}
finally{

    stopActiveBar();

    try{

        saveIndex();

    }
    catch(e){

        console.error(
            "Échec sauvegarde index:",
            e.message
        );

    }

    try{

        await context.close();

    }
    catch(_){}

    try{

        await browser.close();

    }
    catch(_){}

    browserRef = null;

}


if(
    stopping
){

    console.log(
        `\nArrêt demandé — index sauvegardé (${index.total} pistes) | ok:${stats.ok} skip:${stats.skip} fail:${stats.fail}`
    );

    process.exit(0);

}


console.log(
    "\n========== TERMINE =========="
);
console.log(
    `${index.total} musiques indexées | ok:${stats.ok} skip:${stats.skip} fail:${stats.fail}`
);


})().catch(e => {

    if(
        isAbortError(e)
    ){

        stopActiveBar();

        try{
            saveIndex();
        }
        catch(_){}

        if(
            browserRef
        ){
            browserRef.close().catch(() => {});
            browserRef = null;
        }

        console.log(
            `\nArrêt demandé — index sauvegardé (${index.total} pistes) | ok:${stats.ok} skip:${stats.skip} fail:${stats.fail}`
        );

        process.exit(0);

    }

    console.error(
        "Crash fatal:",
        e
    );
    process.exit(1);

});
