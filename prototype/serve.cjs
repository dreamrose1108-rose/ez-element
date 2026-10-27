const http=require('node:http');const fs=require('node:fs');const path=require('node:path');
const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css'};
http.createServer((req,res)=>{const f=files[req.url.split('?')[0]];if(!f){res.writeHead(404);return res.end('Not found')}res.setHeader('Content-Type',f.endsWith('.html')?'text/html; charset=utf-8':f.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');res.end(fs.readFileSync(path.join(__dirname,f)))}).listen(4173,'127.0.0.1',()=>console.log('Prototype: http://127.0.0.1:4173'));
