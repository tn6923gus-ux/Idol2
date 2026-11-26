const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;

const headers = () => ({
  apikey: KEY,
  ...(KEY.startsWith('sb_secret_') ? {} : {
    Authorization: `Bearer ${KEY}`
  }),
  'Content-Type': 'application/json'
});

async function request(path, options = {}) {
  const r = await fetch(URL_BASE + path, {
    ...options,
    headers: {...headers(), ...options.headers}
  });
  if (!r.ok) throw Error('database');
  return r;
}

const integer = (x, max = 1000000000) =>
  Number.isInteger(x) && x >= 0 && x <= max;

function valid(c) {
  return c &&
    typeof c.name === 'string' &&
    c.name.length > 0 &&
    c.name.length <= 100 &&
    typeof c.team === 'string' &&
    c.team.length <= 100 &&
    integer(c.enh, 15) &&
    integer(c.trans, 12) &&
    [1,2,3,4,5].includes(c.grade) &&
    Array.isArray(c.stats) &&
    c.stats.length === 8 &&
    c.stats.every(x => integer(x, 100000)) &&
    Array.isArray(c.buffs) &&
    c.buffs.length <= 20 &&
    c.buffs.every(b =>
      [0,1].includes(b.type) &&
      integer(b.stat, 7) &&
      integer(b.op, 3) &&
      Number.isFinite(b.val) &&
      b.val >= 0 &&
      b.val <= 100000
    );
}

module.exports = async (req, res) => {
  if (req.method !== 'POST')
    return res.status(405).end();

  if (!URL_BASE || !KEY)
    return res.status(503).json({
      error: '서버 설정 필요'
    });

  try {
    let d = typeof req.body === 'string'
      ? JSON.parse(req.body) : req.body;

    if (!d || d.consent !== true)
      return res.status(400).end();

    let row, table, photo = null, path = null;

    if (d.kind === 'character' && valid(d.character)) {
      let c = d.character;
      table = 'characters';

      row = {
        name: c.name,
        team: c.team,
        grade: ['', 'C', 'B', 'A', 'S', 'SS'][c.grade],
        enhancement: c.enh,
        transcendence: c.trans,
        affection: c.stats[7],
        stats: c.stats.slice(0, 7),
        skills: c.buffs
      };

      if (d.photo) {
        let m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(d.photo);

        if (!m) return res.status(400).end();

        photo = Buffer.from(m[2], 'base64');

        if (photo.length > 2 * 1024 * 1024)
          return res.status(413).end();

        let type = m[1];

        if (!(
          type === 'jpeg' &&
          photo[0] === 255 && photo[1] === 216 ||
          type === 'png' &&
          photo.subarray(0,8).equals(
            Buffer.from([137,80,78,71,13,10,26,10])
          ) ||
          type === 'webp' &&
          photo.toString('ascii',0,4) === 'RIFF' &&
          photo.toString('ascii',8,12) === 'WEBP'
        )) return res.status(400).end();

        path = require('crypto').randomUUID() + '.' + type;
        row.image_path = path;
        photo = {bytes: photo, type};
      }

    } else if (
      d.kind === 'measurement' &&
      Array.isArray(d.characters) &&
      d.characters.length === 5 &&
      d.characters.every(valid) &&
      integer(d.predicted) &&
      integer(d.actual) &&
      integer(d.artifact) &&
      d.actual >= d.artifact
    ) {
      table = 'measurements';

      row = {
        characters: d.characters,
        formation: d.characters.map((c,i) => ({
          slot: i+1,
          name: c.name
        })),
        predicted_score: d.predicted,
        actual_score: d.actual - d.artifact,
        artifact_bonus: d.artifact,
        formula_version: 'v4-beta'
      };

    } else {
      return res.status(400).end();
    }

    let quota = await request(
      '/rest/v1/rpc/reserve_research_submission',
      {method: 'POST', body: '{}'}
    );

    if (await quota.json() !== true)
      return res.status(429).json({
        error: '일일 제출 한도'
      });

    if (photo) {
      await request(
        '/storage/v1/object/character-images/' + path,
        {
          method: 'POST',
          headers: {'Content-Type': 'image/' + photo.type},
          body: photo.bytes
        }
      );
    }

    try {
      await request('/rest/v1/' + table, {
        method: 'POST',
        body: JSON.stringify(row)
      });
    } catch(e) {
      if (path) {
        try {
          await request(
            '/storage/v1/object/character-images/' + path,
            {method: 'DELETE'}
          );
        } catch {}
      }
      throw e;
    }

    return res.status(200).json({ok: true});

  } catch {
    return res.status(500).json({
      error: '저장 실패'
    });
  }
};
