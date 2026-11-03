import { applyFieldMappings, getPath, TRANSFORMS } from './field-mapping';

describe('TRANSFORMS', () => {
  it('trimCollapse trims and collapses whitespace, keeping Unicode', () => {
    expect(TRANSFORMS.trimCollapse('  Vasanta  Bhavan،   Madinat Zayed ')).toEqual({ ok: true, value: 'Vasanta Bhavan، Madinat Zayed' });
    expect(TRANSFORMS.trimCollapse(5).ok).toBe(false);
  });

  it('toNumber accepts numbers and numeric strings only', () => {
    expect(TRANSFORMS.toNumber('6.5')).toEqual({ ok: true, value: 6.5 });
    expect(TRANSFORMS.toNumber(9)).toEqual({ ok: true, value: 9 });
    expect(TRANSFORMS.toNumber('').ok).toBe(false);
    expect(TRANSFORMS.toNumber('abc').ok).toBe(false);
  });

  it('toMinorUnits rounds away float32 noise', () => {
    expect(TRANSFORMS.toMinorUnits(50.80000076293945)).toEqual({ ok: true, value: 5080 });
    expect(TRANSFORMS.toMinorUnits(0)).toEqual({ ok: true, value: 0 });
  });

  it('zeroToNull and emptyToNull', () => {
    expect(TRANSFORMS.zeroToNull(0)).toEqual({ ok: true, value: null });
    expect(TRANSFORMS.zeroToNull(4)).toEqual({ ok: true, value: 4 });
    expect(TRANSFORMS.emptyToNull('')).toEqual({ ok: true, value: null });
  });

  it('passes null and undefined through every transform', () => {
    for (const t of Object.values(TRANSFORMS)) {
      expect(t(null)).toEqual({ ok: true, value: null });
      expect(t(undefined)).toEqual({ ok: true, value: undefined });
    }
  });
});

describe('applyFieldMappings', () => {
  const source = { name: '  Bombay  Box ', fee: '9', addr: { area: 'Al Karama' }, rate: 0 };

  it('builds only the target entity, with nested targets, and omits absent fields', () => {
    const out = applyFieldMappings('restaurant', source, [
      { target: 'restaurant.name', from: 'name', transforms: ['trimCollapse'] },
      { target: 'restaurant.delivery.feeMinor', from: 'fee', transforms: ['toNumber', 'toMinorUnits'] },
      { target: 'restaurant.address.area', from: 'addr.area' },
      { target: 'restaurant.rating.value', from: 'rate', transforms: ['zeroToNull'] },
      { target: 'restaurant.logo', from: 'missing.path' },
      { target: 'menu.categories', from: 'name' },
    ]);
    expect(out).toEqual({
      ok: true,
      value: { name: 'Bombay Box', delivery: { feeMinor: 900 }, address: { area: 'Al Karama' }, rating: { value: null } },
    });
  });

  it('reports a failing transform as TRANSFORM_ERROR at the source path', () => {
    expect(applyFieldMappings('restaurant', { fee: 'free' }, [{ target: 'restaurant.delivery.feeMinor', from: 'fee', transforms: ['toNumber'] }])).toEqual({
      ok: false,
      issue: { reason: 'TRANSFORM_ERROR', message: expect.stringContaining('toNumber'), path: 'fee' },
    });
  });

  it('getPath stops at non-objects', () => {
    expect(getPath({ a: { b: 1 } }, 'a.b')).toBe(1);
    expect(getPath({ a: 'str' }, 'a.b')).toBeUndefined();
  });
});
