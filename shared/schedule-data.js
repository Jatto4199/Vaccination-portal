// Default vaccine configuration (Vaccine entity, thesis section 3.12.5), loaded
// into the database on first run and editable by administrators afterwards.
//
// IMPORTANT: this follows the Nigerian routine immunization schedule as
// commonly published (NPHCDA) and WHO guidance on minimum intervals. Verify every
// row against the current official schedule before using it with real
// patients; schedules change (e.g. new vaccine introductions).
//
// One row per vaccine dose. Period format: "<n><unit>", unit d/w/m/y.
//   recommended_age       age at which the dose is due (null = no age rule, e.g. maternal Td)
//   recommended_interval  minimum gap after the previous dose of the same vaccine
//   min_age               youngest age at which the dose counts as valid (catch-up)
//   max_age               oldest age at which the dose may still be given (null = no limit)

const NAMES = {
  BCG: 'BCG (Tuberculosis)',
  HEPB: 'Hepatitis B (birth dose)',
  OPV: 'Oral Polio Vaccine',
  PENTA: 'Pentavalent (DPT-HepB-Hib)',
  PCV: 'Pneumococcal Conjugate',
  ROTA: 'Rotavirus',
  IPV: 'Inactivated Polio Vaccine',
  MCV: 'Measles',
  YF: 'Yellow Fever',
  MENA: 'Meningitis A',
  TD: 'Tetanus-diphtheria (Td)',
};

const child = (code, dose_number, recommended_age, extra = {}) => ({
  code, dose_number, target: 'child', recommended_age,
  recommended_interval: extra.interval ?? null,
  min_age: extra.min_age ?? recommended_age,
  max_age: extra.max_age ?? null,
});

const mother = (dose_number, interval) => ({
  code: 'TD', dose_number, target: 'mother',
  recommended_age: null, recommended_interval: interval, min_age: null, max_age: null,
});

export const DEFAULT_VACCINES = [
  // At birth
  child('BCG', 1, '0d', { max_age: '1y' }),
  child('HEPB', 0, '0d', { max_age: '14d' }),
  child('OPV', 0, '0d', { max_age: '14d' }),
  // 6 weeks
  child('OPV', 1, '6w', { interval: '4w' }),
  child('PENTA', 1, '6w'),
  child('PCV', 1, '6w'),
  child('ROTA', 1, '6w', { max_age: '2y' }),
  child('IPV', 1, '6w'),
  // 10 weeks
  child('OPV', 2, '10w', { min_age: '6w', interval: '4w' }),
  child('PENTA', 2, '10w', { min_age: '6w', interval: '4w' }),
  child('PCV', 2, '10w', { min_age: '6w', interval: '4w' }),
  child('ROTA', 2, '10w', { min_age: '6w', interval: '4w', max_age: '2y' }),
  // 14 weeks
  child('OPV', 3, '14w', { min_age: '6w', interval: '4w' }),
  child('PENTA', 3, '14w', { min_age: '6w', interval: '4w' }),
  child('PCV', 3, '14w', { min_age: '6w', interval: '4w' }),
  child('ROTA', 3, '14w', { min_age: '6w', interval: '4w', max_age: '2y' }),
  child('IPV', 2, '14w', { min_age: '6w', interval: '4w' }),
  // 9 months
  child('MCV', 1, '9m'),
  child('YF', 1, '9m'),
  child('MENA', 1, '9m'),
  // 15 months
  child('MCV', 2, '15m', { min_age: '9m', interval: '4w' }),
  // Maternal tetanus-diphtheria: Td1 at first contact, then by interval.
  mother(1, null),
  mother(2, '4w'),
  mother(3, '6m'),
  mother(4, '1y'),
  mother(5, '1y'),
].map((v, i) => ({
  id: `${v.code}-${v.dose_number}`,
  name: NAMES[v.code],
  ...v,
  sort_order: i + 1,
  status: 'active',
}));
