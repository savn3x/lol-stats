'use strict';

// ── CONFIG ──────────────────────────────────────────────────────────────────

const DD_VERSION = '14.24.1'; // Data Dragon version — update periodically
const DD_BASE = `https://ddragon.leagueoflegends.com/cdn/${DD_VERSION}`;

const ROUTING = {
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe',
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  kr: 'asia', jp1: 'asia', oc1: 'sea',
};

const REGION_LABELS = {
  euw1: 'EUW', eun1: 'EUNE', na1: 'NA', kr: 'KR',
  jp1: 'JP', br1: 'BR', la1: 'LAN', la2: 'LAS',
  tr1: 'TR', ru: 'RU', oc1: 'OCE',
};

const QUEUE_LABELS = {
  420: 'Ranked Solo/Duo', 440: 'Ranked Flex', 450: 'ARAM',
  400: 'Normal Draft', 430: 'Normal Blind', 1700: 'Arena',
  1900: 'URF', 900: 'URF', 1020: 'One for All',
};

// ── STATE ───────────────────────────────────────────────────────────────────

let apiKey = localStorage.getItem('riotApiKey') || '';
let currentPuuid = '';
let currentRegion = 'euw1';
let currentSummonerName = '';
let championData = {};
let spellData = {};

// ── INIT ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  if (!apiKey) {
    document.getElementById('apiModal').style.display = 'flex';
  } else {
    document.getElementById('apiModal').style.display = 'none';
  }

  document.getElementById('searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') search();
  });
  document.getElementById('searchInputHeader').addEventListener('keydown', e => {
    if (e.key === 'Enter') searchFromHeader();
  });

  loadStaticData();
});

async function loadStaticData() {
  try {
    const [champResp, spellResp] = await Promise.all([
      fetch(`${DD_BASE}/data/en_US/champion.json`),
      fetch(`${DD_BASE}/data/en_US/summoner.json`),
    ]);
    const champJson = await champResp.json();
    const spellJson = await spellResp.json();
    Object.values(champJson.data).forEach(c => { championData[c.key] = c; });
    Object.values(spellJson.data).forEach(s => { spellData[s.key] = s; });
  } catch {
    // Non-fatal — icons will be placeholders
  }
}

// ── API KEY MODAL ────────────────────────────────────────────────────────────

function openApiModal() {
  const input = document.getElementById('apiKeyInput');
  input.value = apiKey || '';
  document.getElementById('apiModal').style.display = 'flex';
}

function saveApiKey() {
  const val = document.getElementById('apiKeyInput').value.trim();
  if (!val.startsWith('RGAPI-')) {
    alert('API key must start with RGAPI-');
    return;
  }
  apiKey = val;
  localStorage.setItem('riotApiKey', apiKey);
  document.getElementById('apiModal').style.display = 'none';
}

// ── NAVIGATION ───────────────────────────────────────────────────────────────

function showHome() {
  document.getElementById('homePage').style.display = '';
  document.getElementById('profilePage').style.display = 'none';
  document.getElementById('headerSearch').style.display = 'none';
}

function showProfile() {
  document.getElementById('homePage').style.display = 'none';
  document.getElementById('profilePage').style.display = '';
  document.getElementById('headerSearch').style.display = 'flex';
}

// ── SEARCH ───────────────────────────────────────────────────────────────────

function search() {
  const raw = document.getElementById('searchInput').value.trim();
  const region = document.getElementById('regionSelect').value;
  doSearch(raw, region);
}

function searchFromHeader() {
  const raw = document.getElementById('searchInputHeader').value.trim();
  const region = document.getElementById('regionSelectHeader').value;
  doSearch(raw, region);
}

function refreshProfile() {
  doSearch(currentSummonerName, currentRegion);
}

async function doSearch(raw, region) {
  if (!raw) return;
  if (!apiKey) { document.getElementById('apiModal').style.display = 'flex'; return; }

  const [gameName, tagLine] = raw.includes('#')
    ? [raw.split('#')[0], raw.split('#')[1]]
    : [raw, region.toUpperCase()];

  currentRegion = region;
  currentSummonerName = raw;

  showProfile();
  setLoadingState();

  try {
    const routing = ROUTING[region];

    // 1. Get account by Riot ID
    const accountData = await riotFetch(
      `https://${routing}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
    );
    currentPuuid = accountData.puuid;

    // 2. Get summoner data
    const summonerData = await riotFetch(
      `https://${region}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${currentPuuid}`
    );

    // 3. Get ranked data
    const rankedData = await riotFetch(
      `https://${region}.api.riotgames.com/lol/league/v4/entries/by-summoner/${summonerData.id}`
    );

    // 4. Get last 20 match IDs
    const matchIds = await riotFetch(
      `https://${routing}.api.riotgames.com/lol/match/v5/matches/by-puuid/${currentPuuid}/ids?start=0&count=20`
    );

    // 5. Fetch all matches in parallel (batch to avoid rate limits)
    const matches = await fetchMatchesBatched(matchIds, routing);

    renderProfile(accountData, summonerData, rankedData, matches);
  } catch (err) {
    showError(err.message || 'Unexpected error. Check your API key and try again.');
  }
}

async function fetchMatchesBatched(ids, routing) {
  const results = [];
  const batchSize = 5;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const fetched = await Promise.all(
      batch.map(id =>
        riotFetch(`https://${routing}.api.riotgames.com/lol/match/v5/matches/${id}`).catch(() => null)
      )
    );
    results.push(...fetched.filter(Boolean));
    if (i + batchSize < ids.length) await sleep(500);
  }
  return results;
}

// ── API HELPER ───────────────────────────────────────────────────────────────

async function riotFetch(url) {
  const resp = await fetch(url, { headers: { 'X-Riot-Token': apiKey } });
  if (resp.status === 401 || resp.status === 403) {
    setTimeout(openApiModal, 300);
    throw new Error('Invalid or expired API key — update it below.');
  }
  if (resp.status === 404) throw new Error('Player not found. Check the Riot ID and region.');
  if (resp.status === 429) throw new Error('Rate limit hit. Wait a moment and try again.');
  if (!resp.ok) throw new Error(`API error ${resp.status}`);
  return resp.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── UI STATE ─────────────────────────────────────────────────────────────────

function setLoadingState() {
  document.getElementById('loadingState').style.display = 'flex';
  document.getElementById('errorState').style.display = 'none';
  document.getElementById('profileContent').style.display = 'none';
}

function showError(msg) {
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('errorState').style.display = 'flex';
  document.getElementById('profileContent').style.display = 'none';
  document.getElementById('errorMsg').textContent = msg;
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function renderProfile(account, summoner, ranked, matches) {
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('errorState').style.display = 'none';
  document.getElementById('profileContent').style.display = '';

  // Summoner card
  document.getElementById('profileIcon').src =
    `${DD_BASE}/img/profileicon/${summoner.profileIconId}.png`;
  document.getElementById('summonerName').textContent =
    `${account.gameName}#${account.tagLine}`;
  document.getElementById('summonerLevel').textContent = `Lvl ${summoner.summonerLevel}`;
  document.getElementById('summonerRegion').textContent = REGION_LABELS[currentRegion] || currentRegion.toUpperCase();

  // Header search sync
  document.getElementById('searchInputHeader').value = `${account.gameName}#${account.tagLine}`;
  const hdr = document.getElementById('regionSelectHeader');
  hdr.value = currentRegion;

  // Ranked
  renderRanked(ranked);

  // Compute summaries from matches
  const playerMatches = matches.map(m => extractPlayerData(m, currentPuuid)).filter(Boolean);
  renderSummary(playerMatches);
  renderChampions(playerMatches);
  renderMatches(playerMatches, matches);
}

function renderRanked(ranked) {
  const soloQ = ranked.find(r => r.queueType === 'RANKED_SOLO_5x5');
  const flexQ = ranked.find(r => r.queueType === 'RANKED_TEAM_5x5');
  const section = document.getElementById('rankedSection');

  const entries = [
    { label: 'Ranked Solo/Duo', data: soloQ },
    { label: 'Ranked Flex', data: flexQ },
  ];

  section.innerHTML = entries.map(({ label, data }) => {
    if (!data) return `
      <div class="rank-card">
        <span class="rank-emblem emblem-unranked"></span>
        <div class="rank-info">
          <div class="rank-queue">${label}</div>
          <div class="rank-tier rank-unranked">Unranked</div>
        </div>
      </div>`;
    const wr = Math.round(data.wins / (data.wins + data.losses) * 100);
    const tier = data.tier.toLowerCase();
    const wrClass = wr >= 55 ? 'high' : wr >= 50 ? 'mid' : 'low';
    return `
      <div class="rank-card">
        <span class="rank-emblem emblem-${tier}"></span>
        <div class="rank-info">
          <div class="rank-queue">${label}</div>
          <div class="rank-tier tier-${tier}">${data.tier} ${data.rank}</div>
          <div class="rank-lp">${data.leaguePoints} LP</div>
          <div class="rank-wl">${data.wins}W ${data.losses}L</div>
        </div>
        <span class="rank-wr-badge ${wrClass}">${wr}%</span>
      </div>`;
  }).join('');
}

function renderSummary(playerMatches) {
  if (!playerMatches.length) return;
  const wins = playerMatches.filter(m => m.win).length;
  const losses = playerMatches.length - wins;
  const wr = Math.round(wins / playerMatches.length * 100);
  const avgKills = avg(playerMatches, m => m.kills);
  const avgDeaths = avg(playerMatches, m => m.deaths);
  const avgAssists = avg(playerMatches, m => m.assists);
  const kda = avgDeaths === 0 ? 'Perfect' : ((avgKills + avgAssists) / avgDeaths).toFixed(2);
  const avgCs = avg(playerMatches, m => m.cs);
  const avgVision = avg(playerMatches, m => m.visionScore);

  const wrClass = wr >= 55 ? 'positive' : wr < 45 ? 'negative' : 'neutral';

  document.getElementById('summaryContent').innerHTML = `
    <div class="summary-wr-row">
      <div class="summary-wr-big ${wrClass}">${wr}%</div>
      <div class="summary-wl">${wins}W / ${losses}L</div>
    </div>
    <div class="summary-bar-wrap">
      <div class="summary-bar-fill" style="width:${wr}%"></div>
    </div>
    <div class="summary-stats-grid">
      <div class="stat-item stat-kda">
        <div class="stat-value">${avgKills.toFixed(1)} / <span style="color:var(--loss)">${avgDeaths.toFixed(1)}</span> / ${avgAssists.toFixed(1)}</div>
        <div class="stat-label">Avg K/D/A</div>
      </div>
      <div class="stat-item stat-kda">
        <div class="stat-value">${kda}</div>
        <div class="stat-label">KDA Ratio</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${avgCs.toFixed(0)}</div>
        <div class="stat-label">Avg CS</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${avgVision.toFixed(0)}</div>
        <div class="stat-label">Avg Vision</div>
      </div>
    </div>`;
}

function renderChampions(playerMatches) {
  const champMap = {};
  playerMatches.forEach(m => {
    if (!champMap[m.championId]) {
      champMap[m.championId] = { name: m.championName, id: m.championId, games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 };
    }
    const c = champMap[m.championId];
    c.games++; c.wins += m.win ? 1 : 0;
    c.kills += m.kills; c.deaths += m.deaths; c.assists += m.assists;
  });

  const sorted = Object.values(champMap).sort((a, b) => b.games - a.games).slice(0, 7);

  document.getElementById('championsContent').innerHTML = sorted.map(c => {
    const wr = Math.round(c.wins / c.games * 100);
    const kda = c.deaths === 0 ? '∞' : ((c.kills + c.assists) / c.deaths).toFixed(2);
    const avgK = (c.kills / c.games).toFixed(1);
    const avgD = (c.deaths / c.games).toFixed(1);
    const avgA = (c.assists / c.games).toFixed(1);
    const wrClass = wr >= 55 ? 'win' : wr < 45 ? 'loss' : 'win';
    return `
      <div class="champ-row">
        <img class="champ-icon" src="${DD_BASE}/img/champion/${getChampionImage(c.id)}" alt="${c.name}" onerror="this.style.display='none'"/>
        <div>
          <div class="champ-name">${c.name}</div>
          <div class="champ-games">${c.games} game${c.games > 1 ? 's' : ''}</div>
        </div>
        <div class="champ-kda">${avgK}/${avgD}/${avgA}<br/><span style="color:var(--accent);font-size:11px">${kda} KDA</span></div>
        <div class="champ-wr ${wrClass}">${wr}%</div>
      </div>`;
  }).join('');
}

function renderMatches(playerMatches, rawMatches) {
  const list = document.getElementById('matchList');
  list.innerHTML = playerMatches.map((m, i) => {
    const raw = rawMatches[i];
    const queueLabel = QUEUE_LABELS[raw?.info?.queueId] || 'Custom';
    const duration = raw ? formatDuration(raw.info.gameDuration) : '';
    const ago = raw ? timeAgo(raw.info.gameStartTimestamp) : '';
    const kda = m.deaths === 0 ? '∞' : ((m.kills + m.assists) / m.deaths).toFixed(2);
    const kdaClass = parseFloat(kda) >= 4 ? 'high' : '';
    const items = m.items.filter(id => id > 0);

    return `
      <div class="match-card ${m.win ? 'win' : 'loss'}">
        <div class="match-side-bar"></div>
        <div class="match-champ-col">
          <img class="match-champ-img" src="${DD_BASE}/img/champion/${getChampionImage(m.championId)}" alt="${m.championName}" onerror="this.src=''"/>
          <div class="match-spells">
            ${m.spells.map(k => `<img class="spell-icon" src="${DD_BASE}/img/spell/${getSpellImage(k)}" alt="" onerror="this.style.display='none'"/>`).join('')}
          </div>
          <div class="match-items">
            ${items.slice(0, 4).map(id => `<img class="item-icon" src="${DD_BASE}/img/item/${id}.png" alt="" onerror="this.style.visibility='hidden'"/>`).join('')}
          </div>
        </div>
        <div class="match-info-col">
          <div class="match-outcome">${m.win ? 'Victory' : 'Defeat'}</div>
          <div class="match-queue">${queueLabel}</div>
          <div class="match-kda-text">${m.kills} / <span style="color:var(--loss)">${m.deaths}</span> / ${m.assists}</div>
          <div class="match-kda-ratio ${kdaClass}">${kda} KDA</div>
        </div>
        <div class="match-stats-col">
          <div class="match-cs">${m.cs} CS (${m.cspm}/min)</div>
          <div class="match-damage">${(m.damage/1000).toFixed(1)}k dmg</div>
          <div class="match-duration">${duration}</div>
          <div class="match-ago">${ago}</div>
        </div>
      </div>`;
  }).join('');
}

// ── DATA EXTRACTION ──────────────────────────────────────────────────────────

function extractPlayerData(match, puuid) {
  if (!match?.info?.participants) return null;
  const p = match.info.participants.find(x => x.puuid === puuid);
  if (!p) return null;
  const durationMin = match.info.gameDuration / 60;
  return {
    win: p.win,
    championId: p.championId,
    championName: p.championName,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    cs: p.totalMinionsKilled + p.neutralMinionsKilled,
    cspm: durationMin > 0 ? ((p.totalMinionsKilled + p.neutralMinionsKilled) / durationMin).toFixed(1) : 0,
    damage: p.totalDamageDealtToChampions,
    visionScore: p.visionScore,
    goldEarned: p.goldEarned,
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
    spells: [p.summoner1Id, p.summoner2Id],
  };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function avg(arr, fn) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + fn(x), 0) / arr.length;
}

function formatDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function getChampionImage(championId) {
  const champ = championData[String(championId)];
  return champ ? `${champ.image.full}` : `${championId}.png`;
}

function getSpellImage(spellKey) {
  const spell = Object.values(spellData).find(s => String(s.key) === String(spellKey));
  return spell ? spell.image.full : '';
}
