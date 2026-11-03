/**
 * Each test is named after the data anomaly it covers (docs/DATA_ANALYSIS.md §3).
 * Inputs are copied from the sample data unless marked otherwise.
 */
import {
  emptyToNull,
  extractUrlId,
  extractUrlSegment,
  parseDurationRange,
  placeholderToNull,
  toGeoPoint,
  toMinorUnits,
  toNumber,
  trimCollapse,
  zeroToNull,
} from './normalisers';

const value = <T>(r: { ok: true; value: T } | { ok: false }): T | 'ISSUE' => (r.ok ? r.value : 'ISSUE');

describe('normalisers', () => {
  it('names with trailing and double spaces are trimmed and collapsed', () => {
    expect(value(trimCollapse('Healthy Bowl '))).toBe('Healthy Bowl');
    expect(value(trimCollapse('% Arabica,  Al Markaziyah'))).toBe('% Arabica, Al Markaziyah');
    expect(value(trimCollapse(' Tab\tand\nnewline '))).toBe('Tab and newline'); // NBSP etc. (constructed)
  });

  it('names keep the Arabic comma, en dash and accents (NFC-normalised)', () => {
    expect(value(trimCollapse('Vasanta Bhavan، Madinat Zayed'))).toBe('Vasanta Bhavan، Madinat Zayed');
    expect(value(trimCollapse('Awani – Middle Eastern Flavors'))).toBe('Awani – Middle Eastern Flavors');
    // "Café" with a combining accent (constructed) becomes the composed form used in the data.
    expect(value(trimCollapse('Adnoc Oasis Café'))).toBe('Adnoc Oasis Café');
  });

  it('float32 price noise is absorbed into integer minor units', () => {
    expect(value(toMinorUnits(50.80000076293945))).toBe(5080);
    expect(value(toMinorUnits(90.70000305175782))).toBe(9070);
    expect(value(toMinorUnits(0))).toBe(0); // zero prices are kept, not dropped
  });

  it('deliveryFee as a numeric string becomes minor units', () => {
    expect(value(toMinorUnits('9'))).toBe(900);
    expect(value(toMinorUnits('6.5'))).toBe(650);
    expect(value(toMinorUnits('1.99'))).toBe(199);
    expect(value(toMinorUnits('0'))).toBe(0); // free delivery
  });

  it('numeric strings parse; non-numeric text is an issue, not a silent NaN', () => {
    expect(value(toNumber('6.5'))).toBe(6.5);
    expect(value(toNumber(9))).toBe(9);
    expect(value(toNumber(''))).toBeNull();
    const abc = toNumber('abc');
    expect(abc).toEqual({ ok: false, issue: expect.objectContaining({ reason: 'SCHEMA_INVALID', message: expect.stringContaining('"abc"') }) });
    expect(value(toNumber('0x10'))).toBe('ISSUE'); // Number() would accept this; we do not
  });

  it('placeholder contact "00000-00000" becomes null', () => {
    const contact = [/^0+-0+$/];
    expect(value(placeholderToNull('00000-00000', contact))).toBeNull();
    expect(value(placeholderToNull('04-123-4567', contact))).toBe('04-123-4567'); // constructed real-looking number
    expect(() => placeholderToNull('x', [/0+/g])).toThrow(/g or y flag/); // stateful regex = impure
  });

  it('empty description and address become null', () => {
    expect(value(emptyToNull(''))).toBeNull();
    expect(value(emptyToNull('   '))).toBeNull();
    expect(value(emptyToNull('Business Bay'))).toBe('Business Bay');
  });

  it('DeliveryTime ranges and single values parse; free text is an issue', () => {
    expect(value(parseDurationRange('25-40 mins'))).toEqual({ minMinutes: 25, maxMinutes: 40 });
    expect(value(parseDurationRange('30 mins'))).toEqual({ minMinutes: 30, maxMinutes: 30 });
    expect(value(parseDurationRange('soon'))).toBe('ISSUE');
    expect(value(parseDurationRange('40-25 mins'))).toBe('ISSUE'); // inverted (constructed)
  });

  it('DeliveryTime "0 mins" means unknown and becomes null', () => {
    expect(value(parseDurationRange('0 mins'))).toBeNull();
  });

  it('string coordinates become a GeoJSON Point [lng, lat]; blank or out-of-range is null', () => {
    expect(value(toGeoPoint('25.23018894217186', '55.31936521220774'))).toEqual({
      type: 'Point',
      coordinates: [55.31936521220774, 25.23018894217186],
    });
    expect(value(toGeoPoint('', ''))).toBeNull();
    expect(value(toGeoPoint('95', '55.3'))).toBeNull();
    expect(value(toGeoPoint('0', '0'))).toBeNull(); // "null island" placeholder
    expect(value(toGeoPoint('abc', '55.3'))).toBeNull(); // never an issue: geo is optional
  });

  it('rating 0 means unrated and becomes null; real ratings are unchanged', () => {
    expect(value(zeroToNull(0))).toBeNull();
    expect(value(zeroToNull(4.4))).toBe(4.4);
    expect(value(zeroToNull(4))).toBe(4);
  });

  it('restaurant id and country exist only inside the URL', () => {
    const url = 'https://www.talabat.com/uae/restaurant/648607/sla-restaurant-and-cafe-al-rowdah?aid=1468';
    expect(value(extractUrlId(url, /\/restaurant\/(\d+)\//))).toBe(648607);
    expect(value(extractUrlSegment(url, /^https?:\/\/[^/]+\/([^/]+)\/restaurant\//))).toBe('uae');
    expect(value(extractUrlId('https://www.talabat.com/uae/offers', /\/restaurant\/(\d+)\//))).toBe('ISSUE');
    expect(() => extractUrlId(url, /\/restaurant\/\d+\//)).toThrow(/capture group/);
  });

  it('every normaliser maps null and undefined to null', () => {
    const fns = [trimCollapse, emptyToNull, toNumber, (v: unknown) => toMinorUnits(v), zeroToNull, parseDurationRange];
    for (const fn of fns) {
      expect(fn(null)).toEqual({ ok: true, value: null });
      expect(fn(undefined)).toEqual({ ok: true, value: null });
    }
    expect(value(toGeoPoint(undefined, null))).toBeNull();
  });
});
