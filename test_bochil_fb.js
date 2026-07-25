const { facebook } = require('@bochilteam/scraper-facebook');

async function test() {
  const url = "https://www.facebook.com/share/p/1EWDAauwS8/";
  try {
    const res = await facebook(url);
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    console.error("Error:", err);
  }
}
test();
