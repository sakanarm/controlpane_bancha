// Reads the app manifests in contracts/examples. A tiny line reader, not a YAML parser: the manifests are ours and the
// parts read here (metadata, baseUrl, the flat roles list, delivery mode) keep one shape. Validate the full file with
// contracts/app-manifest.schema.json when a manifest changes.
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'contracts', 'examples');

const scalar = v => { v = v.replace(/\s+#.*$/, '').trim(); return v === 'true' ? true : v === 'false' ? false : v; };

function read(file) {
  const m = { file: path.basename(file), roles: [] };
  let section = null, role = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    let x;
    if ((x = line.match(/^kind:\s*(\S+)/))) m.kind = x[1];
    else if (/^\S/.test(line)) section = line.replace(/:.*/, '');
    else if (section === 'metadata' && (x = line.match(/^  (key|name|description|owner):\s*(.+)/))) m[x[1]] = scalar(x[2]);
    else if (section === 'spec' && (x = line.match(/^  (baseUrl|version):\s*(.+)/))) m[x[1]] = scalar(x[2]);
    else if (section === 'spec' && /^  roles:\s*$/.test(line)) section = 'roles';
    else if (section === 'roles' && /^  \S/.test(line)) section = 'spec';
    if (section === 'roles') {
      if ((x = line.match(/^    - key:\s*(\S+)/))) m.roles.push(role = { key: x[1] });
      else if (role && (x = line.match(/^      (name|description|appValue|scoped|default):\s*(.+)/))) role[x[1]] = scalar(x[2]);
    }
    if (section === 'spec' && (x = line.match(/^    mode:\s*(\S+)/))) m.deliveryMode = x[1];
  }
  return m;
}

const all = () => fs.readdirSync(DIR).filter(f => f.endsWith('.bancha-app.yaml')).map(f => read(path.join(DIR, f)));

// Role key -> { appValue, scoped, ... } for one app, as arak-push.js needs it.
function roleMap(appKey) {
  const m = all().find(x => x.key === appKey);
  if (!m) throw new Error(`no manifest for ${appKey} in contracts/examples`);
  return Object.fromEntries(m.roles.map(r => [r.key, r]));
}

module.exports = { DIR, read, all, roleMap };
