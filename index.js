const express = require('express');
const { chromium } = require('playwright');
const fetch = require('node-fetch');
const dns = require('dns').promises;
const OpenAI = require('openai');

const app = express();
const port = 3000;
const WHOIS_API_KEY = 'at_ACJ5jeTKK0B0yUd7kNRNX12meLzu3';

// ✅ OpenAI config (gebruik enkel process.env)
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

app.get('/check-return', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).json({ error: 'Geen URL opgegeven.' });
    }

    let domain = new URL(url).hostname.replace('www.', '');
    let browser;

    try {
        browser = await chromium.connectOverCDP('wss://chrome.browserless.io?token=SGgChRJHY7Yojqfe24c9dc3481346fa3de4bbbc10b');
        const page = await browser.newPage();

        // 1️⃣ WHOIS
        const whoisResponse = await fetch(`https://www.whoisxmlapi.com/whoisserver/WhoisService?apiKey=${WHOIS_API_KEY}&domainName=${domain}&outputFormat=JSON`);
        const whoisData = await whoisResponse.json();
        let domainAge = 'Niet gevonden';
        if (whoisData.WhoisRecord?.createdDate) {
            const createdDate = new Date(whoisData.WhoisRecord.createdDate);
            const age = new Date().getFullYear() - createdDate.getFullYear();
            domainAge = `${age} jaar oud`;
        } else if (whoisData.WhoisRecord?.registryData?.createdDate) {
            const createdDate = new Date(whoisData.WhoisRecord.registryData.createdDate);
            const age = new Date().getFullYear() - createdDate.getFullYear();
            domainAge = `${age} jaar oud (via registryData)`;
        }

        // 2️⃣ IP + Serverlocatie
        let serverLocation = 'Onbekend';
        try {
            const addresses = await dns.lookup(domain);
            const geoResponse = await fetch(`https://ip-geolocation.whoisxmlapi.com/api/v1?apiKey=${WHOIS_API_KEY}&ipAddress=${addresses.address}`);
            const geoData = await geoResponse.json();
            serverLocation = geoData?.location?.country || 'Onbekend';
        } catch (e) { console.log('Geo error:', e.message); }

        // 3️⃣ Domeinreputatie
        const repResponse = await fetch(`https://domain-reputation.whoisxmlapi.com/api/v1?apiKey=${WHOIS_API_KEY}&domainName=${domain}`);
        const repData = await repResponse.json();
        let reputation = 'Onbekend';
        if (repData?.reputationScore !== undefined) {
            reputation = `Veilig (score: ${repData.reputationScore})`;
        }

        // 4️⃣ SSL
        const sslPresent = url.startsWith('https://') ? 'SSL-certificaat aanwezig' : 'Geen SSL-certificaat';

        // 5️⃣ BING scraping
        const searchUrl = `https://www.bing.com/search?q=${domain}+reviews&count=20`;
        await page.goto(searchUrl, { waitUntil: 'networkidle' });

        const results = await page.$$eval('li.b_algo', nodes => {
            return nodes.map(node => {
                const title = node.querySelector('h2')?.innerText || '';
                const link = node.querySelector('a')?.href || '';
                const snippet = node.querySelector('.b_caption p')?.innerText || '';
                return { title, link, snippet };
            }).filter(r => r.title && r.link);
        });

        // 🔥 AI-advies genereren
        let aiAdvice = 'Niet beschikbaar.';
        if (results.length > 0) {
            const reviewSummary = results.map((r, i) => `${i + 1}. ${r.title} - ${r.snippet}`).join('\n');

            const aiResponse = await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [
                    { role: 'system', content: 'Je bent een expert in het analyseren van webwinkel-reviews.' },
                    { role: 'user', content: `Hier zijn zoekresultaten over ${domain}. Geef een korte samenvatting van de algemene klanttevredenheid en een advies:\n\n${reviewSummary}` }
                ],
                max_tokens: 300,
                temperature: 0.5
            });

            aiAdvice = aiResponse.choices?.[0]?.message?.content?.trim() || 'Geen advies beschikbaar.';
        }

        // ✅ Vertrouwensscore berekenen
        let score = 0;
        if (domainAge.includes('jaar')) {
            const years = parseInt(domainAge.match(/\d+/));
            if (years >= 5) score += 20;
        }
        if (sslPresent.includes('aanwezig')) score += 20;
        const repMatch = reputation.match(/score: (\d+(\.\d+)?)/);
        if (repMatch?.[1]) {
            score += Math.min((parseFloat(repMatch[1]) * 0.5), 50);
        }

        const advies = score >= 70 ? 'Deze webshop lijkt betrouwbaar.' : 'Wees voorzichtig bij deze webshop.';

        await browser.close();

        // ✅ Resultaat teruggeven
        res.json({
            domeinleeftijd: domainAge,
            ssl: sslPresent,
            serverlocatie: serverLocation,
            domeinreputatie: reputation,
            vertrouwensscore: `${Math.round(score)}/100`,
            advies: advies,
            reviewBronnen: results,
            aiAdvies: aiAdvice
        });

    } catch (error) {
        console.error(error);
        if (browser) await browser.close();
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
