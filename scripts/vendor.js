// Ship a local, offline Mermaid bundle with the extension.
const fs = require('fs');
const path = require('path');
const folder = path.join(__dirname, '..', 'media', 'vendor');
fs.mkdirSync(folder, { recursive: true });
fs.copyFileSync(require.resolve('mermaid/dist/mermaid.min.js'), path.join(folder, 'mermaid.min.js'));
