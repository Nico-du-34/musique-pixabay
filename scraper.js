const { chromium } = require("playwright");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const pLimit = require("p-limit").default;


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


    concurrency:3,

    delay:3000

};


// ==============================
// INIT
// ==============================


const limit =
pLimit(CONFIG.concurrency);


const sleep =
ms=>new Promise(r=>setTimeout(r,ms));


fs.ensureDirSync(
    CONFIG.downloadFolder
);


let index = {

    generated_at:
    new Date(),

    total:0,

    tracks:[]

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



// ==============================
// UTILITAIRES
// ==============================


function clean(text){

    return text
    ?.replace(/[<>:"\/\\|?*]/g,"")
    .replace(/\s+/g,"-")
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


        Cinematic:[
            "cinematic",
            "epic",
            "movie",
            "orchestra"
        ],


        Ambient:[
            "ambient",
            "relax",
            "nature",
            "calm"
        ],


        Gaming:[
            "game",
            "battle",
            "fantasy",
            "rpg"
        ],


        Electronic:[
            "electronic",
            "synth",
            "techno",
            "dance"
        ],


        Horror:[
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
                x=>txt.includes(x)
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
    .replace("./library/","")
    .replaceAll("\\","/");


    return `https://raw.githubusercontent.com/${CONFIG.githubUser}/${CONFIG.githubRepo}/main/${relative}`;

}



// ==============================
// DOWNLOAD
// ==============================


async function download(url,file){


    if(
        fs.existsSync(file)
    ){

        return;

    }


    const response =
    await axios({

        url,

        method:"GET",

        responseType:"stream"

    });



    await new Promise(
    (resolve,reject)=>{


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


}



// ==============================
// SCRAPE MUSIQUE
// ==============================


async function scrapeMusic(
    url,
    browser
){


    const page =
    await browser.newPage();



    try{


        await page.goto(
            url,
            {
                waitUntil:"networkidle",
                timeout:60000
            }
        );



        const data =
        await page.evaluate(()=>{


            const title =
            document.querySelector("h1")
            ?.innerText
            ||
            "unknown";


            const audio =
            document.querySelector("audio")
            ?.src;



            const tags =
            [...document.querySelectorAll(
                "a"
            )]
            .map(
                x=>x.innerText
            )
            .filter(
                x=>x.length
            );



            return {

                title,

                audio,

                tags

            };


        });



        if(
            !data.audio
        ){

            return;

        }



        const category =
        categoryFromTags(
            data.tags
        );



        const filename =
        clean(
            data.title
        )
        +".mp3";



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



        await download(
            data.audio,
            file
        );



        const sha =
        hashFile(file);



        if(
            index.tracks
            .some(
                t=>t.hash===sha
            )
        ){

            return;

        }



        const relative =
        file
        .replace("./library/","");



        index.tracks.push({

            id:
            crypto.randomUUID(),


            title:
            data.title,


            filename,


            category,


            tags:
            data.tags,


            source:{

                pixabay:url,

                download:
                data.audio

            },


            repository:{

                github:
                githubUrl(file)

            },


            file:{

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
                spaces:2
            }
        );


        console.log(
            "OK",
            data.title
        );



    }
    catch(e){

        console.log(
            "Erreur",
            url
        );

    }
    finally{

        await page.close();

    }


}




// ==============================
// SCRAPE PAGE
// ==============================


async function scrapePage(
    num,
    browser
){


    console.log(
        "PAGE",
        num
    );


    const page =
    await browser.newPage();



    await page.goto(
        CONFIG.baseUrl+num,
        {
            waitUntil:"networkidle",
            timeout:60000
        }
    );



    const links =
    await page.evaluate(()=>{


        return [
            ...document.querySelectorAll(
                "a"
            )
        ]
        .map(
            a=>a.href
        )
        .filter(
            x=>x.includes("/music/")
        );


    });



    await page.close();



    const unique =
    [...new Set(links)];



    for(
        const link of unique
    ){

        await limit(
            ()=>scrapeMusic(
                link,
                browser
            )
        );

    }


}



// ==============================
// START
// ==============================


(async()=>{


const browser =
await chromium.launch({

    headless:true

});



for(
let i=1;
i<=CONFIG.pages;
i++
){

    await scrapePage(
        i,
        browser
    );


    await sleep(
        CONFIG.delay
    );

}



await browser.close();


console.log(
    "TERMINE",
    index.total,
    "musiques"
);


})();