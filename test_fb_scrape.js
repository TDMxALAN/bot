const cheerio = require('cheerio');

async function test() {
  const url = "https://www.facebook.com/share/p/1EWDAauwS8/";
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html'
      }
    });
    const html = await res.text();
    
    // Find URLs that look like facebook image urls (scontent...)
    // They are often inside JSON encoded strings
    const scontentRegex = /https:\\\/\\\/scontent[^\s"']+/g;
    const scontentRegex2 = /https:\/\/scontent[^\s"']+/g;
    
    let matches = html.match(scontentRegex2);
    if (matches) {
        // filter out obvious non-images if necessary, or just decode
        let urls = matches.map(u => u.replace(/\\/g, '')).filter(u => u.includes('.jpg') || u.includes('.png'));
        console.log("Found matches:", urls.length);
        console.log([...new Set(urls)].slice(0, 5));
    } else {
        console.log("No images found with standard regex");
    }
  } catch (err) {
    console.error(err);
  }
}
test();
