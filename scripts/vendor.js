// Ship a local, offline Mermaid bundle with the extension.
const fs = require('fs');
const path = require('path');
const folder = path.join(__dirname, '..', 'media', 'vendor');
fs.mkdirSync(folder, { recursive: true });
fs.copyFileSync(require.resolve('mermaid/dist/mermaid.min.js'), path.join(folder, 'mermaid.min.js'));

// One versioned application payload prevents mixed cached modules in webviews.
const media = path.join(__dirname, '..', 'media');
fs.writeFileSync(path.join(media, 'mindsprout.js'), ['core.js', 'rich.js', 'mindmap.js'].map(file => fs.readFileSync(path.join(media, file), 'utf8')).join('\n;\n'));
