import { isAuthed } from "./_auth.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://qoskpyfgimjcmmxunfji.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

let cache = null;
let cacheAt = 0;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function sql(query) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/execute_read_sql`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql_query: query.trim() }),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function loadHierarchy() {
  const rows = await sql(`
    SELECT DISTINCT division, division_code, region, region_code, chapter, chapter_code
    FROM county_rankings
    WHERE division IS NOT NULL AND division <> 'Not Assigned'
    ORDER BY division, region, chapter
    LIMIT 10000;
  `);

  const divisions = new Map();
  const regions = new Map();
  const chapters = [];

  for (const r of rows) {
    if (r.division && !divisions.has(r.division_code || r.division)) {
      divisions.set(r.division_code || r.division, {
        name: r.division,
        code: r.division_code,
      });
    }
    const regionKey = `${r.division_code}|${r.region_code || r.region}`;
    if (r.region && !regions.has(regionKey)) {
      regions.set(regionKey, {
        name: r.region,
        code: r.region_code,
        division: r.division,
        division_code: r.division_code,
      });
    }
    if (r.chapter) {
      chapters.push({
        name: r.chapter,
        code: r.chapter_code,
        region: r.region,
        region_code: r.region_code,
        division: r.division,
        division_code: r.division_code,
      });
    }
  }

  const dedupeChapters = [];
  const seen = new Set();
  for (const c of chapters) {
    const k = c.code || c.name;
    if (seen.has(k)) continue;
    seen.add(k);
    dedupeChapters.push(c);
  }

  // States — use ArcGIS county data to get full state names
  const stateRows = await sql(`
    SELECT state_abbr, COUNT(*) AS counties
    FROM county_rankings
    WHERE state_abbr IS NOT NULL
    GROUP BY state_abbr
    ORDER BY state_abbr
  `);
  const STATE_NAMES = {AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",DC:"District of Columbia",PR:"Puerto Rico",VI:"Virgin Islands",GU:"Guam",AS:"American Samoa",MP:"Northern Mariana Islands"};
  const states = stateRows.map(r => ({
    name: STATE_NAMES[r.state_abbr] || r.state_abbr,
    code: r.state_abbr,
  }));

  // Counties for the county-level scope selector
  const countyRows = await sql(`
    SELECT DISTINCT county_fips, county_name, state_abbr, chapter, region, division
    FROM county_rankings
    WHERE county_fips IS NOT NULL AND county_name IS NOT NULL
    ORDER BY county_name, state_abbr
    LIMIT 5000
  `);

  const counties = countyRows.map(r => ({
    name: `${r.county_name}, ${r.state_abbr}`,
    code: String(r.county_fips).padStart(5, "0"),
    state_abbr: r.state_abbr,
    chapter: r.chapter,
    region: r.region,
    division: r.division,
  }));

  return {
    states,
    divisions: [...divisions.values()].sort((a, b) => a.name.localeCompare(b.name)),
    regions: [...regions.values()].sort((a, b) => a.name.localeCompare(b.name)),
    chapters: dedupeChapters.sort((a, b) => a.name.localeCompare(b.name)),
    counties,
  };
}

export default async function handler(req, res) {
  if (!isAuthed(req)) return res.status(401).json({ error: "unauthenticated" });
  if (!SUPABASE_ANON_KEY) return res.status(500).json({ error: "SUPABASE_ANON_KEY not configured" });

  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) {
    return res.status(200).json({ ...cache, cached: true });
  }

  try {
    const data = await loadHierarchy();
    cache = data;
    cacheAt = now;
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
