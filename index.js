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
        }

// 2️⃣ IP Geolocatie ophalen (serverlocatie)

// 🔄 Eerst IP-adres ophalen via DNS
let ipAddress = '';
try {
    const addresses = await dns.lookup(domain);
    ipAddress = addresses.address;
    console.log(`Gevonden IP-adres: ${ipAddress}`);
} catch (e) {
    console.log('Kon IP-adres niet ophalen:', e.message);
}

// 🔄 Daarna de locatie ophalen
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

        // 5️⃣ Retourbeleid scraping
        const browser = await chromium.connectOverCDP('wss://chrome.browserless.io?token=SGgChRJHY7Yojqfe24c9dc3481346fa3de4bbbc10b');
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle' });

        const content = await page.content();
        let retourResult = 'Geen retourbeleid gevonden.';

        if (/retour/i.test(content) || /herroepingsrecht/i.test(content)) {
            retourResult = 'Retourbeleid gevonden op homepage';
        }

        await browser.close();

        res.json({
            domeinleeftijd: domainAge,
            ssl: sslPresent,
            serverlocatie: serverLocation,
            domeinreputatie: reputation,
            retourbeleid: retourResult
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
