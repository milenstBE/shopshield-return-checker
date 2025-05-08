const express = require('express');
const { chromium } = require('playwright');
const fetch = require('node-fetch');
const dns = require('dns').promises;
require('dotenv').config();
const OpenAI = require('openai');

const app = express();
const port = 3000;
const WHOIS_API_KEY = 'at_ACJ5jeTKK0B0yUd7kNRNX12meLzu3';

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

        // WHOIS - Domeinleeftijd
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

        // IP + Serverlocatie
        let serverLocation = 'Onbekend';
        try {
            const addresses = await dns.lookup(domain);
            const geoResponse = await fetch(`https://ip-geolocation.whoisxmlapi.com/api/v1?apiKey=${WHOIS_API_KEY}&ipAddress=${addresses.address}`);
            const geoData = await geoResponse.json();
            serverLocation = geoData?.location?.country || 'Onbekend';
        } catch (e) { console.log('Geo error:', e.message); }

        // Domeinreputatie
        const repResponse = await fetch(`https://domain-reputation.whoisxmlapi.com/api/v1?apiKey=${WHOIS_API_KEY}&domainName=${domain}`);
        const repData = await repResponse.json();
        let reputation = 'Onbekend';
        if (repData?.reputationScore !== undefined) {
            reputation = `Veilig (score: ${repData.reputationScore})`;
        }

        // SSL
        const sslPresent = url.startsWith('https://') ? 'SSL-certificaat aanwezig' : 'Geen SSL-certificaat';

        // BING scraping (reviews + retourbeleid)
        const searchUrl = `https://www.bing.com/search?q=${domain}+reviews+site:trustpilot.com+OR+site:sitejabber.com+OR+site:kiyoh.com&count=15`;
        await page.goto(searchUrl, { waitUntil: 'networkidle' });

        const reviews = await page.$$eval('li.b_algo', nodes => {
            return nodes.slice(0, 8).map(node => {
                const title = node.querySelector('h2')?.innerText || '';
                const link = node.querySelector('a')?.href || '';
                const snippet = node.querySelector('.b_caption p')?.innerText || '';
                return { title, link, snippet };
            }).filter(r => r.title && r.link);
        });

        // Simpele retourbeleid check (nieuwe extra zoekopdracht)
        let retourbeleid = 'Niet gevonden';
        try {
            const retourUrl = `https://www.bing.com/search?q=${domain}+retourbeleid+site:${domain}`;
            await page.goto(retourUrl, { waitUntil: 'networkidle' });
            const retourText = await page.$eval('.b_caption p', el => el.innerText);
            if (retourText) {
                retourbeleid = retourText.slice(0, 300) + '...';
            }
        } catch (e) { console.log('Geen retourbeleid gevonden.'); }

        // Extra: keurmerken en contactinfo proberen afleiden van homepage
        let keurmerken = 'Niet gevonden';
        let contactInfo = 'Niet gevonden';
        try {
            await page.goto(`https://${domain}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
            const bodyText = await page.evaluate(() => document.body.innerText);
            if (bodyText.match(/keurmerk|veilig shoppen|thuiswinkel/i)) {
                keurmerken = 'Keurmerk of Veilig Shoppen-label gevonden.';
            }
            if (bodyText.match(/contact|over ons|klantenservice/i)) {
                contactInfo = 'Contactpagina aanwezig.';
            }
        } catch (e) { console.log('Keurmerk/contact scan niet gelukt.'); }

        // AI-analyse
        let analyse = 'Niet beschikbaar.';
        let gemiddeldeScore = 'Niet beschikbaar';
        let aantalReviews = 'Niet beschikbaar';
        let trend = 'Geen trends gevonden';

        if (reviews.length > 0) {
            const reviewSummary = reviews.map((r, i) => `${i + 1}. ${r.title} - ${r.snippet}`).join('\n');

            const aiResponse = await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [
                    { role: 'system', content: 'Je bent een expert in het analyseren van webwinkel-reviews.' },
                    { role: 'user', content: `Hier zijn zoekresultaten over ${domain}. Analyseer:\n- Hoeveel reviews ongeveer zijn gevonden en wat de gemiddelde sterrenscore is.\n- Wat klanten positief en negatief zeggen.\n- Zijn er klachten of trends zichtbaar in de reviews?\n- Geef daarna een kort en duidelijk advies voor consumenten of ze veilig kunnen bestellen.\n\nResultaten:\n${reviewSummary}` }
                ],
                max_tokens: 500,
                temperature: 0.5
            });

            const content = aiResponse.choices?.[0]?.message?.content?.trim() || 'Geen analyse beschikbaar.';
            analyse = content;

            // Extractie verbeterd
            const scoreMatch = content.match(/(?:gemiddelde|overall).*?(\d(\.\d)?\/5)/i);
            if (scoreMatch) gemiddeldeScore = scoreMatch[1];

            const reviewsMatch = content.match(/(ongeveer|ca\.?)\s*\d{2,6}/i);
            if (reviewsMatch) aantalReviews = reviewsMatch[0];

            const trendMatch = content.match(/(trend:|trends:|de laatste tijd|recent.*(positief|negatief|klachten))/i);
            if (trendMatch) trend = trendMatch[0];
        }

        // Vertrouwensscore berekenen
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

        // ✅ Teruggeven
        res.json({
            advies,
            vertrouwensscore: `${Math.round(score)}/100`,
            gemiddeldeScore,
            aantalReviews,
            trend,
            keurmerken,
            contactInfo,
            domeinleeftijd: domainAge,
            ssl: sslPresent,
            serverlocatie: serverLocation,
            domeinreputatie: reputation,
            retourbeleid,
            reviewBronnen: reviews,
            analyse
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
