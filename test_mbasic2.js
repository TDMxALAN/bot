const cheerio = require('cheerio');

async function test() {
  const url = "https://www.facebook.com/share/p/1EWDAauwS8/".replace("www.facebook.com", "mbasic.facebook.com");
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    
    // Find all links to photos
    const photoLinks = [];
    $('a').each((i, el) => {
        const href = $(el).attr('href');
        if (href && (href.includes('/photo.php') || href.includes('/photo/'))) {
            photoLinks.push(href);
        }
    });
    console.log("Found photo links:", photoLinks.length);
    
    // Also look for any img tags that might be the main photos
    const imgs = [];
    $('img').each((i, el) => {
        const src = $(el).attr('src');
        if (src && src.includes('scontent')) {
            imgs.push(src);
        }
    });
    console.log("Found scontent imgs:", imgs.length);
    if (imgs.length > 0) {
        console.log(imgs[0]);
    }
  } catch (err) {
    console.error(err);
  }
}
test();
