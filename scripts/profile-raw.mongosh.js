/* eslint-disable */
// Reproduces every number in docs/DATA_ANALYSIS.md from the seeded raw database.
//
//   docker compose exec -T mongo mongosh --quiet provider_raw < scripts/profile-raw.mongosh.js
//
// Never prints endpoint / requests_url: they contain a live provider API key.

const out = {};
const typeOf = (v) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : v instanceof Date ? 'date' : v instanceof ObjectId ? 'objectId' : typeof v;
const inc = (m, k, n = 1) => (m[k] = (m[k] || 0) + n);
const parseUrl = (u) => {
  // https://www.talabat.com/{country}/restaurant/{outletId}/{slug}?aid={areaId}
  const m = /^https?:\/\/[^/]+\/([^/]+)\/restaurant\/(\d+)\/([^?]+)\?aid=(\d+)/.exec(u || '');
  return m ? { country: m[1], outletId: Number(m[2]), slug: m[3], aid: Number(m[4]) } : null;
};
/** Field path -> sorted type list, over the given objects. */
const shape = (objs) => {
  const s = {};
  for (const o of objs) for (const [k, v] of Object.entries(o)) (s[k] = s[k] || new Set()).add(typeOf(v));
  return Object.fromEntries(Object.entries(s).map(([k, t]) => [k, [...t].sort().join('|')]));
};

// ---------------------------------------------------------------- envelope
{
  const all = ['xbyte_raw_locations', 'xbyte_raw_restaurants', 'xbyte_raw_menus'].flatMap((c) => db[c].find().toArray());
  const statusCodes = {}, procTimeTypes = {}, reqLogStatus = {}, domains = {};
  for (const d of all) {
    inc(statusCodes, d.statusCode);
    inc(domains, d.domain);
    const rl = (d.payload || {}).request_log || {};
    inc(procTimeTypes, typeOf(rl.request_process_time));
    inc(reqLogStatus, rl.statusCode);
  }
  out.envelope = {
    docs: all.length,
    topLevelShape: shape(all),
    requestLogShape: shape(all.map((d) => (d.payload || {}).request_log || {})),
    statusCodes,
    requestLogStatusCodes: reqLogStatus,
    domains,
    request_process_time_types: procTimeTypes,
    endpointHasApiKey: all.filter((d) => /api_key=/.test(d.endpoint || '')).length,
    requestsUrlHasApiKey: all.filter((d) => /api_key=/.test(((d.payload || {}).request_log || {}).requests_url || '')).length,
    sampleRequestTimeVsCreatedAt: all.slice(0, 2).map((d) => ({ request_time: d.payload.request_log.request_time, createdAt: d.createdAt })),
  };
}

// ---------------------------------------------------------------- locations
{
  const docs = db.xbyte_raw_locations.find().toArray();
  const rows = docs.flatMap((d) => d.payload.results);
  const byId = {}, idsBySlug = {};
  for (const r of rows) {
    byId[r.location_id] = r;
    (idsBySlug[r.location_slug] = idsBySlug[r.location_slug] || new Set()).add(r.location_id);
  }
  const fingerprint = (d) => JSON.stringify(d.payload.results.map((r) => [r.location_id, r.location_name, r.location_slug]).sort());
  const dupSlugs = Object.entries(idsBySlug).filter(([, ids]) => ids.size > 1);
  out.locations = {
    docs: docs.length,
    payloadKeys: shape(docs.map((d) => d.payload)),
    resultShape: shape(rows),
    rows: rows.length,
    uniqueIds: Object.keys(byId).length,
    rowsPerDoc: docs.map((d) => d.payload.results.length),
    distinctSnapshots: new Set(docs.map(fingerprint)).size,
    slugsWithMultipleIds: dupSlugs.length,
    dupSlugExamples: Object.fromEntries(dupSlugs.map(([s, ids]) => [s, [...ids]])),
    uniqueSlugs: Object.keys(idsBySlug).length,
  };
}

// ---------------------------------------------------------------- restaurants
{
  const docs = db.xbyte_raw_restaurants.find().toArray();
  const payloadVariants = {}, docsPerArea = {}, fetchesPerPage = {}, contentsPerPage = {}, totalPage = {}, rowsPerPage = {};
  const byOutlet = {}; // outletId -> Set(areaSlug)
  let rows = 0, slugMismatch = 0, badUrls = 0;
  const countries = {}, aidMatchesParam = { yes: 0, no: 0 };
  const names = new Set();
  for (const d of docs) {
    const p = d.payload;
    inc(payloadVariants, Object.keys(p).filter((k) => k !== 'request_log').sort().join(','));
    const area = d.params.areaSlug;
    inc(docsPerArea, area);
    const pageKey = `${area}#${d.params.page_no}`;
    inc(fetchesPerPage, pageKey);
    const res = p.results || [];
    (contentsPerPage[pageKey] = contentsPerPage[pageKey] || new Set()).add(JSON.stringify(res.map((r) => r.restaurant_url).sort()));
    inc(totalPage, p['Total Page']);
    inc(rowsPerPage, res.length);
    for (const r of res) {
      rows++;
      names.add(r.restaurant_name);
      const u = parseUrl(r.restaurant_url);
      if (!u) { badUrls++; continue; }
      inc(countries, u.country);
      inc(aidMatchesParam, String(u.aid) === d.params.areaId ? 'yes' : 'no');
      (byOutlet[u.outletId] = byOutlet[u.outletId] || new Set()).add(area);
      if (!u.slug.endsWith(area)) slugMismatch++;
    }
  }
  const nameList = [...names];
  out.restaurants = {
    docs: docs.length,
    paramsShape: shape(docs.map((d) => d.params)),
    resultShape: shape(docs.flatMap((d) => d.payload.results || [])),
    payloadVariants,
    docsPerArea,
    areaIdsByArea: docs.reduce((m, d) => ((m[d.params.areaSlug] = d.params.areaId), m), {}),
    distinctPages: Object.keys(fetchesPerPage).length,
    maxFetchesOfOnePage: Math.max(...Object.values(fetchesPerPage)),
    pagesFetchedMoreThanOnce: Object.values(fetchesPerPage).filter((n) => n > 1).length,
    pagesWhoseRefetchesDiffer: Object.entries(contentsPerPage).filter(([k, s]) => fetchesPerPage[k] > 1 && s.size > 1).length,
    totalPageValues: totalPage,
    rowsPerPageHistogram: rowsPerPage,
    rows,
    uniqueRestaurants: Object.keys(byOutlet).length,
    inBothAreas: Object.values(byOutlet).filter((s) => s.size > 1).length,
    rowsWhoseUrlSlugDoesNotEndWithListingArea: slugMismatch,
    urlCountrySegments: countries,
    urlAidEqualsParamsAreaId: aidMatchesParam,
    unparseableUrls: badUrls,
    names: {
      distinct: nameList.length,
      trailingOrLeadingSpace: nameList.filter((n) => n !== n.trim()).length,
      doubleSpace: nameList.filter((n) => /\s{2,}/.test(n)).length,
      arabicComma: nameList.filter((n) => n.includes('،')).length,
      enDash: nameList.filter((n) => n.includes('–')).length,
      nonAscii: nameList.filter((n) => /[^\x00-\x7F]/.test(n)).length,
    },
  };
}

// ---------------------------------------------------------------- menus
{
  const docs = db.xbyte_raw_menus.find().toArray();
  const payloadVariants = {}, resultsLen = {}, aids = {};
  const valuesOf = { City: {}, Contact: {}, totalReviews: {}, deliveryFee: {}, DeliveryTime: {} };
  const restaurants = [];
  for (const d of docs) {
    const p = d.payload;
    inc(payloadVariants, Object.keys(p).filter((k) => k !== 'request_log').sort().join(','));
    const u = parseUrl(d.params.restaurant_url);
    if (u) inc(aids, u.aid);
    if (!Array.isArray(p.results)) continue;
    inc(resultsLen, p.results.length);
    const r = p.results[0];
    for (const k of Object.keys(valuesOf)) inc(valuesOf[k], `${typeOf(r[k])}:${r[k]}`);
    restaurants.push({ r, u });
  }
  const listingOutlets = new Set(
    db.xbyte_raw_restaurants.find().toArray().flatMap((d) => (d.payload.results || []).map((x) => (parseUrl(x.restaurant_url) || {}).outletId)),
  );
  let itemRows = 0, zeroPrice = 0, floatNoise = 0, ratingZero = 0, imageNull = 0, emptyDesc = 0, multiCategoryItems = 0;
  let picksRestaurants = 0, picksIdCollisions = 0, picksItemsAlsoElsewhere = 0, multiCatNonPicks = 0;
  const itemIdOwners = {}, priceTypes = {}, ratingTypes = {}, imageTypes = {}, categoriesPerMenu = [];
  let idEqualsUrl = 0, outletEqualsUrl = 0;
  for (const { r, u } of restaurants) {
    if (u && r.id === u.outletId) idEqualsUrl++;
    if (u && r.outletCode === u.outletId) outletEqualsUrl++;
    const cats = r.category || [];
    categoriesPerMenu.push(cats.length);
    const picks = cats.filter((c) => /^Picks for you/i.test(c.category_name));
    const real = cats.filter((c) => !/^Picks for you/i.test(c.category_name));
    if (picks.length) picksRestaurants++;
    if (picks.some((p) => real.some((c) => c.category_id === p.category_id))) picksIdCollisions++;
    const catsByItem = {};
    for (const c of cats) {
      for (const it of c.items || []) {
        itemRows++;
        (catsByItem[it.item_id] = catsByItem[it.item_id] || []).push(c);
        (itemIdOwners[it.item_id] = itemIdOwners[it.item_id] || new Set()).add(r.outletCode);
        inc(priceTypes, Number.isInteger(it.price) ? 'int' : typeOf(it.price) === 'number' ? 'float' : typeOf(it.price));
        inc(ratingTypes, typeOf(it.rating));
        inc(imageTypes, typeOf(it.image));
        if (it.price === 0) zeroPrice++;
        if (typeof it.price === 'number' && Math.round(it.price * 100) / 100 !== it.price) floatNoise++;
        if (it.rating === 0) ratingZero++;
        if (it.image === null) imageNull++;
        if (!it.description || !String(it.description).trim()) emptyDesc++;
      }
    }
    for (const cs of Object.values(catsByItem)) {
      if (cs.length < 2) continue;
      multiCategoryItems++;
      if (cs.some((c) => /^Picks for you/i.test(c.category_name))) picksItemsAlsoElsewhere++;
      else multiCatNonPicks++;
    }
  }
  const allRestaurantFields = shape(restaurants.map(({ r }) => r));
  out.menus = {
    docs: docs.length,
    payloadVariants,
    notRestaurantPage: docs.filter((d) => /not restaurant page/i.test(d.payload.Message || '')).length,
    resultsArrayLengths: resultsLen,
    restaurantFieldShape: allRestaurantFields,
    categoryShape: shape(restaurants.flatMap(({ r }) => r.category || [])),
    itemShape: shape(restaurants.flatMap(({ r }) => (r.category || []).flatMap((c) => c.items || []))),
    constantishValues: Object.fromEntries(Object.entries(valuesOf).map(([k, m]) => [k, Object.keys(m).length > 6 ? `${Object.keys(m).length} distinct` : m])),
    menuUrlAid: aids,
    payloadIdEqualsUrlId: `${idEqualsUrl}/${restaurants.length}`,
    outletCodeEqualsUrlId: `${outletEqualsUrl}/${restaurants.length}`,
    menuOutletsInListingSample: restaurants.filter(({ r }) => listingOutlets.has(r.outletCode)).length,
    categoriesPerMenu: { min: Math.min(...categoriesPerMenu), max: Math.max(...categoriesPerMenu), avg: +(categoriesPerMenu.reduce((a, b) => a + b, 0) / categoriesPerMenu.length).toFixed(1) },
    picks: { restaurantsWithPicks: picksRestaurants, restaurantsWherePicksIdCollidesWithRealCategory: picksIdCollisions },
    items: {
      rows: itemRows,
      uniqueItemIds: Object.keys(itemIdOwners).length,
      itemIdsSharedAcrossRestaurants: Object.values(itemIdOwners).filter((s) => s.size > 1).length,
      inMoreThanOneCategory: multiCategoryItems,
      ofWhichViaPicks: picksItemsAlsoElsewhere,
      ofWhichNotPicks: multiCatNonPicks,
      priceTypes, ratingTypes, imageTypes,
      zeroPrice, floatNoisePrices: floatNoise,
      ratingZero, ratingZeroPct: +((100 * ratingZero) / itemRows).toFixed(1),
      imageNull, emptyDescription: emptyDesc,
    },
  };
}

// ---------------------------------------------------------------- follow-ups (cross-checks, value distributions)
{
  const isPicks = (c) => /^Picks for you/i.test(c.category_name);
  const menus = db.xbyte_raw_menus.find({ 'payload.results': { $exists: true } }).toArray().map((d) => d.payload.results[0]);
  const locs = db.xbyte_raw_locations.findOne().payload.results;
  const locSlugs = [...new Set(locs.map((l) => l.location_slug))];
  const vals = (k) => menus.reduce((o, m) => (inc(o, m[k]), o), {});
  const x = {};

  // Category-id collisions inside one menu, split by kind.
  let picksOnly = 0, realOnly = 0, both = 0;
  for (const m of menus) {
    const realIds = m.category.filter((c) => !isPicks(c)).map((c) => c.category_id);
    const rr = new Set(realIds).size < realIds.length;
    const pr = m.category.filter(isPicks).some((p) => realIds.includes(p.category_id));
    if (rr && pr) both++; else if (rr) realOnly++; else if (pr) picksOnly++;
  }
  x.categoryIdCollisions = { menusWithAnyDuplicateCategoryId: picksOnly + realOnly + both, picksVsReal: picksOnly + both, realVsReal: realOnly + both };

  // Items in more than one category, two ways of counting.
  let byEntries = 0, byDistinctIds = 0;
  for (const m of menus) {
    const ent = {};
    for (const c of m.category) for (const it of c.items) (ent[it.item_id] = ent[it.item_id] || []).push(c.category_id);
    for (const v of Object.values(ent)) { if (v.length > 1) byEntries++; if (new Set(v).size > 1) byDistinctIds++; }
  }
  x.itemsInMoreThanOneCategory = { byCategoryEntries: byEntries, byDistinctCategoryIds: byDistinctIds };
  x.menusWithZeroCategories = menus.filter((m) => !m.category.length).length;

  x.deliveryFee = vals('deliveryFee');
  x.DeliveryTime = vals('DeliveryTime');
  x.minimumOrder = vals('Minimum Order');
  const lat = menus.map((m) => parseFloat(m.latitude)), lng = menus.map((m) => parseFloat(m.longitude));
  x.geo = { nonNumeric: lat.filter(isNaN).length + lng.filter(isNaN).length, latRange: [Math.min(...lat), Math.max(...lat)], lngRange: [Math.min(...lng), Math.max(...lng)] };
  x.rate = { min: Math.min(...menus.map((m) => m.rate)), max: Math.max(...menus.map((m) => m.rate)), nonInteger: menus.filter((m) => !Number.isInteger(m.rate)).length, zero: menus.filter((m) => m.rate === 0).length };
  x.totalRatings = { max: Math.max(...menus.map((m) => m.totalRatings)), atMax1000: menus.filter((m) => m.totalRatings === 1000).length, zero: menus.filter((m) => m.totalRatings === 0).length, zeroAlsoRateZero: menus.filter((m) => m.totalRatings === 0 && m.rate === 0).length };
  x.emptyAddress = menus.filter((m) => !String(m['Restaurant Address'] || '').trim()).length;
  x.menuNames = { leadingOrTrailingSpace: menus.filter((m) => m.name !== m.name.trim()).length, distinct: new Set(menus.map((m) => m.name)).size, of: menus.length };
  x.distinctVendorIds = new Set(menus.map((m) => m.id)).size;
  x.distinctOutletCodes = new Set(menus.map((m) => m.outletCode)).size;
  const prices = menus.flatMap((m) => m.category.flatMap((c) => c.items.map((i) => i.price)));
  x.itemPriceRange = [Math.min(...prices), Math.max(...prices)];
  x.itemRatingValues = menus.reduce((o, m) => (m.category.forEach((c) => c.items.forEach((i) => inc(o, i.rating))), o), {});
  x.floatNoiseExamples = [...new Set(prices.filter((p) => Math.round(p * 100) / 100 !== p))].slice(0, 3);
  x.menuDocsPerRestaurantUrl = { distinctUrls: new Set(db.xbyte_raw_menus.distinct('params.restaurant_url')).size, docs: db.xbyte_raw_menus.countDocuments() };

  // Listing URL slug vs the listing area: same area, another known area, or no area suffix.
  let same = 0, other = 0, none = 0;
  const outletsByName = {};
  for (const d of db.xbyte_raw_restaurants.find().toArray()) for (const r of d.payload.results || []) {
    const u = parseUrl(r.restaurant_url);
    (outletsByName[r.restaurant_name.trim()] = outletsByName[r.restaurant_name.trim()] || new Set()).add(u.outletId);
    if (u.slug.endsWith(d.params.areaSlug)) same++;
    else if (locSlugs.some((s) => u.slug.endsWith('-' + s))) other++;
    else none++;
  }
  x.listingSlugVsArea = { endsWithListingArea: same, endsWithADifferentKnownArea: other, noRecognisableArea: none };
  x.namesSharedBySeveralOutlets = Object.values(outletsByName).filter((s) => s.size > 1).length;

  x.relationshipIdsInLocations = locs.filter((l) => [1468, 1461, 1280].includes(l.location_id)).map((l) => `${l.location_id}=${l.location_name}`);
  x.locationNamesWithDoubleSpace = locs.filter((l) => /\s{2,}/.test(l.location_name)).length;

  const colls = ['xbyte_raw_locations', 'xbyte_raw_restaurants', 'xbyte_raw_menus'];
  const offsets = {};
  for (const c of colls) for (const d of db[c].find({}, { 'payload.request_log.request_time': 1, createdAt: 1 }).toArray()) {
    inc(offsets, Math.round((d.createdAt - new Date(d.payload.request_log.request_time.replace(' ', 'T') + 'Z')) / 36e5));
  }
  x.createdAtMinusRequestTimeHours = offsets;
  x.updatedAtEqualsCreatedAt = colls.map((c) => `${c}: ${db[c].countDocuments({ $expr: { $eq: ['$createdAt', '$updatedAt'] } })}/${db[c].countDocuments()}`);
  x.versionKeyValues = [...new Set(colls.flatMap((c) => db[c].distinct('__v')))];
  x.createdAtRange = colls.map((c) => {
    const [lo] = db[c].find({}, { createdAt: 1 }).sort({ createdAt: 1 }).limit(1).toArray();
    const [hi] = db[c].find({}, { createdAt: 1 }).sort({ createdAt: -1 }).limit(1).toArray();
    return `${c}: ${lo.createdAt.toISOString()} .. ${hi.createdAt.toISOString()}`;
  });
  out.followUps = x;
}

print(JSON.stringify(out, null, 2));
