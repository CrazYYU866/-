import { ORDER_STATUSES, SETTINGS_REGISTRY, toCustomerVisibleStatus, type SettingKey } from '@kovsh/contracts';

describe('@kovsh/contracts', () => {
  it('каждый технический статус сопоставлен видимому статусу', () => {
    for (const s of ORDER_STATUSES) expect(toCustomerVisibleStatus(s)).toBeDefined();
  });

  it('все утверждённые значения по умолчанию проходят собственную схему', () => {
    for (const key of Object.keys(SETTINGS_REGISTRY) as SettingKey[]) {
      const { schema, default: def } = SETTINGS_REGISTRY[key];
      if (def !== null) expect(schema.safeParse(def).success).toBe(true);
    }
  });

  it('веса подбора по умолчанию дают 100% (К-6)', () => {
    const sum =
      SETTINGS_REGISTRY.matching_weight_distance.default +
      SETTINGS_REGISTRY.matching_weight_rating.default +
      SETTINGS_REGISTRY.matching_weight_reliability.default +
      SETTINGS_REGISTRY.matching_weight_load.default;
    expect(sum).toBe(100);
  });
});
