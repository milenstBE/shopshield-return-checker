const express = require('express');
const { chromium } = require('playwright');
const fetch = require('node-fetch');
const dns = require('dns').promises;

const app = express();
const port = 3000;
const WHOIS_API_KEY = 'at_ACJ5jeTKK0B0yUd7kNRNX12meLzu3';

app.get('/check-return', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).json({ error: 'Geen URL opgegeven.' });
    }

    let domain = new URL(url).hostname.replace('www.', '');

    try {
        // 1️⃣ WHOIS: Domeinleeftijd ophalen
        const whoisResponse = await fetch(`https://www.whoisxmlapi.com/whoisserver/WhoisService?apiKey=${WHOIS_API_KEY}&domainName=${domain}&outputFormat=JSON`);
        const whoisData = await whoisResponse.json();

        let domainAge = 'Niet gevonden';
if (whoisData.WhoisRecord && whoisData.WhoisRecord.createdDate) {
    const createdDate = new Date(whoisData.WhoisRecord.createdDate);
    const age = new Date().getFullYear() - createdDate.getFullYear();
    domainAge = `${age} jaar oud`;
} else if (whoisData.WhoisRecord && whoisData.WhoisRecord.registryData && whoisData.WhoisRecord.registryData.createdDate) {
    const createdDate = new Date(whoisData.WhoisRecord.registryData.createdDate);
    const age = new Date().getFullYear() - createdDate.getFullYear();
    domainAge = `${age} jaar oud (via registryData)`;
} else if (whoisData.WhoisRecord && whoisData.WhoisRecord.rawText) {
    const match = whoisData.WhoisRecord.rawText.match(/Creation Date:\s*(\d{4}-\d{2}-\d{2})/i);
    if (match && match[1]) {
        const createdDate = new Date(match[1]);
        const age = new Date().getFullYear() - createdDate.getFullYear();
        domainAge = `${age} jaar oud (via rawText)`;
    }
}


        // 2️⃣ IP Geolocatie ophalen (serverlocatie)
        let ipAddress = '';
        try {
            const addresses = await dns.lookup(domain);
            ipAddress = addresses.address;
            console.log(`Gevonden IP-adres: ${ipAddress}`);
        } catch (e) {
            console.log('Kon IP-adres niet ophalen:', e.message);
        }

        let serverLocation = 'Onbekend';
        if (ipAddress) {
            const geoResponse = await fetch(`https://ip-geolocation.whoisxmlapi.com/api/v1?apiKey=${WHOIS_API_KEY}&ipAddress=${ipAddress}`);
            const geoData = await geoResponse.json();
            serverLocation = geoData && geoData.location && geoData.location.country ? geoData.location.country : 'Onbekend';
        }

        // 3️⃣ Domain reputation ophalen
        const repResponse = await fetch(`https://domain-reputation.whoisxmlapi.com/api/v1?apiKey=${WHOIS_API_KEY}&domainName=${domain}`);
        const repData = await repResponse.json();
        let reputation = 'Onbekend';
        if (repData && repData.reputationScore !== undefined) {
            reputation = `Veilig (score: ${repData.reputationScore})`;
        }

        // 4️⃣ SSL-certificaat checken
        const sslPresent = url.startsWith('https://') ? 'SSL-certificaat aanwezig' : 'Geen SSL-certificaat';

        // 5️⃣ Retourbeleid scraping (slimmer)
        const browser = await chromium.connectOverCDP('wss://chrome.browserless.io?token=SGgChRJHY7Yojqfe24c9dc3481346fa3de4bbbc10b');
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle' });

const retourKeywords = [
    'retour', 'herroepingsrecht', 'terugsturen', 'retourneren', 'ruilen', 'geld terug', 'bedenktijd',
    'return', 'withdrawal right', 'send back', 'returning', 'exchange', 'money back', 'cooling-off period',
    'klantenservice', 'veelgestelde vragen', 'service', 'annuleren', 'levering', 'verzending',
    'customer service', 'faq', 'help', 'cancel', 'delivery', 'shipping'
];


        // Zoek naar retour-link op homepage
const retourLink = await page.$$eval('a', (links, keywords) => {
    const found = links.find(link =>
        keywords.some(keyword =>
            (link.textContent && link.textContent.toLowerCase().includes(keyword)) ||
            (link.href && link.href.toLowerCase().includes(keyword))
        )
    );
    return found ? found.href : null;
}, retourKeywords);


        let retourResult = 'Geen retourbeleid gevonden.';
        if (retourLink) {
            // Bezoek retourpagina
            try {
                const retourPage = await browser.newPage();
                await retourPage.goto(retourLink, { waitUntil: 'networkidle' });
                const retourContent = await retourPage.content();
                if (retourKeywords.some(kw => retourContent.toLowerCase().includes(kw))) {
                    retourResult = 'Retourbeleid gevonden op retourpagina.';
                } else {
                    retourResult = 'Retourpagina gevonden, maar geen duidelijk retourbeleid.';
                }
                await retourPage.close();
            } catch (e) {
                console.log('Kon retourpagina niet scrapen:', e.message);
                retourResult = 'Retourpagina gevonden, maar kon niet worden gelezen.';
            }
        } else {
            // Geen link gevonden, fallback naar homepage check
            const content = await page.content();
            if (retourKeywords.some(kw => content.toLowerCase().includes(kw))) {
                retourResult = 'Retourbeleid gevonden op homepage.';
            }
        }

        await browser.close();

        // 🔥 Algemene vertrouwensscore berekenen
let score = 0;

// +20 als domein ouder is dan 5 jaar
if (domainAge.includes('jaar')) {
    const years = parseInt(domainAge.match(/\d+/));
    if (years >= 5) score += 20;
}

// +20 als SSL aanwezig
if (sslPresent.includes('aanwezig')) {
    score += 20;
}

// + Domeinreputatie (bijv. 98.9 => ~49)
const repMatch = reputation.match(/score: (\d+(\.\d+)?)/);
if (repMatch && repMatch[1]) {
    score += Math.min((parseFloat(repMatch[1]) * 0.5), 50);
}

// +10 als retourbeleid gevonden
if (retourResult.includes('gevonden')) {
    score += 10;
}

const advies = score >= 70 ? 'Deze webshop lijkt betrouwbaar.' : 'Wees voorzichtig bij deze webshop.';


        // ✅ Resultaat teruggeven
res.json({
    domeinleeftijd: domainAge,
    ssl: sslPresent,
    serverlocatie: serverLocation,
    domeinreputatie: reputation,
    retourbeleid: retourResult,
    vertrouwensscore: `${Math.round(score)}/100`,
    advies: advies
});

    } catch (error) {
        console.error(error);
        res.status(500).json({
            error: 'Er is een fout opgetreden tijdens het controleren.',
            details: error.message,
            stack: error.stack
        });
    }
});

app.listen(port, () => {
    console.log(`Server draait op http://localhost:${port}`);
});
