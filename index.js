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
        }

        // 2️⃣ IP Geolocatie ophalen (serverlocatie)
        let ipAddress = '';
        try {
            const addresses = await dns.lookup(domain);
            ipAddress = addresses.address;
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

        // 5️⃣ Retourbeleid + Reviews scraping
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
                retourResult = 'Retourpagina gevonden, maar kon niet worden gelezen.';
            }
        } else {
            const content = await page.content();
            if (retourKeywords.some(kw => content.toLowerCase().includes(kw))) {
                retourResult = 'Retourbeleid gevonden op homepage.';
            }
        }

        // 🔥 Reviews verzamelen
        const reviews = {
            trustpilot: 'Geen info beschikbaar.',
            sitejabber: 'Geen info beschikbaar.',
            google: 'Controleer handmatig (Google Maps)',
            yelp: 'Geen data gevonden.',
            facebook: 'Geen data gevonden.'
        };

        // Trustpilot scraping
        try {
            const trustPage = await browser.newPage();
            await trustPage.goto(`https://www.trustpilot.com/review/${domain}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
            const trustContent = await trustPage.content();
            const trustScore = await trustPage.$eval('[data-business-unit-summary-rating] [data-rating]', el => el.getAttribute('data-rating')).catch(() => null);
            const trustReviews = await trustPage.$eval('[data-business-unit-summary-rating] .typography_body-l__KUYFJ', el => el.textContent).catch(() => null);
            if (trustScore && trustReviews) {
                reviews.trustpilot = `${trustScore}/5 ⭐ (${trustReviews.trim()})`;
            } else {
                reviews.trustpilot = 'Geen reviews gevonden.';
            }
            await trustPage.close();
        } catch (e) {
            reviews.trustpilot = 'Trustpilot niet bereikbaar.';
        }

        // Sitejabber scraping
        try {
            const sjPage = await browser.newPage();
            await sjPage.goto(`https://www.sitejabber.com/reviews/${domain}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
            const sjScore = await sjPage.$eval('.average-rating', el => el.textContent).catch(() => null);
            const sjCount = await sjPage.$eval('.rating-amount', el => el.textContent).catch(() => null);
            if (sjScore && sjCount) {
                reviews.sitejabber = `${sjScore.trim()} ⭐ (${sjCount.trim()})`;
            } else {
                reviews.sitejabber = 'Geen reviews gevonden.';
            }
            await sjPage.close();
        } catch (e) {
            reviews.sitejabber = 'Sitejabber niet bereikbaar.';
        }

        await browser.close();

        // 🔥 Algemene vertrouwensscore berekenen
        let score = 0;
        if (domainAge.includes('jaar')) {
            const years = parseInt(domainAge.match(/\d+/));
            if (years >= 5) score += 20;
        }
        if (sslPresent.includes('aanwezig')) {
            score += 20;
        }
        const repMatch = reputation.match(/score: (\d+(\.\d+)?)/);
        if (repMatch && repMatch[1]) {
            score += Math.min((parseFloat(repMatch[1]) * 0.5), 50);
        }
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
            advies: advies,
            reviews: reviews
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
