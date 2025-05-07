const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/check-return', async (req, res) => {
    const url = req.query.url;

    if (!url) {
        return res.status(400).json({ error: 'Geen URL opgegeven.' });
    }

    let browser;
    try {
        const browser = await chromium.connectOverCDP('wss://chrome.browserless.io?token=SGgChRJHY7Yojqfe24c9dc3481346fa3de4bbbc10b');
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle' });

        // Zoektermen voor retourbeleid
        const zoekwoorden = ['retour', 'herroep', 'geld terug', 'voorwaarden'];
        const content = await page.content();
        let gevonden = false;
        let gevondenWoord = '';

        for (const woord of zoekwoorden) {
            if (content.toLowerCase().includes(woord)) {
                gevonden = true;
                gevondenWoord = woord;
                break;
            }
        }

        if (!gevonden) {
            // Probeer ook links naar retourpagina's te vinden
            const links = await page.$$eval('a', anchors => anchors.map(a => ({
                href: a.href,
                text: a.innerText
            })));

            for (const link of links) {
                if (zoekwoorden.some(woord => link.href.toLowerCase().includes(woord))) {
                    await page.goto(link.href, { waitUntil: 'networkidle' });
                    const subContent = await page.content();
                    for (const woord of zoekwoorden) {
                        if (subContent.toLowerCase().includes(woord)) {
                            gevonden = true;
                            gevondenWoord = woord + ' (gevonden op subpagina)';
                            break;
                        }
                    }
                    if (gevonden) break;
                }
            }
        }

        res.json({
            found: gevonden,
            details: gevonden
                ? `Retourbeleid gevonden (${gevondenWoord}).`
                : 'Geen retourbeleid gevonden.'
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ 
            error: 'Er is een fout opgetreden tijdens het controleren.',
            details: error.message,
            stack: error.stack
        });
    } finally {
        if (browser) await browser.close();
    }
});

app.get('/', (req, res) => {
    res.send('ShopShield Return Checker draait ✅');
});

app.listen(PORT, () => {
    console.log(`Server draait op poort ${PORT}`);
});
