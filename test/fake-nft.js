'use strict';
// A stand-in for the head unit's nft, for test/run.js: it keeps a ruleset in the file $FAKE_NFT_STATE (JSON) and
// knows what the NES game loader asks of nft: "-a list ruleset", "insert rule ...", "delete rule ... handle n".
// Every call is also written to <that file>.log.
const fs = require('fs');
const file = process.env.FAKE_NFT_STATE;
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const a = process.argv.slice(2);
fs.appendFileSync(file + '.log', a.join(' ') + '\n');
const chain = (fam, table, name) => { const t = st.tables.find((x) => x.family === fam && x.name === table); const c = t && t.chains.find((x) => x.name === name); if (!c) { console.error('Error: No such file or directory'); process.exit(1); } return c; };
if (a[0] === '-a' && a[1] === 'list' && a[2] === 'ruleset') {
    st.tables.forEach((t, i) => {
        console.log('table ' + t.family + ' ' + t.name + ' { # handle ' + (i + 1));
        t.chains.forEach((c, j) => {
            console.log('\tchain ' + c.name + ' { # handle ' + (j + 1));
            if (c.hook) console.log('\t\ttype filter hook ' + c.hook + ' priority filter; policy ' + (c.policy || 'accept') + ';');
            c.rules.forEach((r) => console.log('\t\t' + r.text + ' # handle ' + r.handle));
            console.log('\t}');
        });
        console.log('}');
    });
} else if (a[0] === 'insert' && a[1] === 'rule') {
    chain(a[2], a[3], a[4]).rules.unshift({ text: a.slice(5).join(' '), handle: ++st.next });
} else if (a[0] === 'delete' && a[1] === 'rule' && a[5] === 'handle') {
    const c = chain(a[2], a[3], a[4]), i = c.rules.findIndex((r) => String(r.handle) === a[6]);
    if (i < 0) { console.error('Error: Could not process rule: No such file or directory'); process.exit(1); }
    c.rules.splice(i, 1);
} else { console.error('fake nft: ' + a.join(' ')); process.exit(2); }
fs.writeFileSync(file, JSON.stringify(st));
