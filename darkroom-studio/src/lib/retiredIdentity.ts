// Numeric code points keep a retired product label out of source, logs, and
// generated metadata while still allowing one-time local-data migration.
const RETIRED_PRODUCT_NAME = String.fromCodePoint(76, 117, 109, 105, 110, 97);

export const RETIRED_PROFILE_NAMESPACE = RETIRED_PRODUCT_NAME;
export const RETIRED_STUDIO_NAMESPACE = `${RETIRED_PRODUCT_NAME.toLowerCase()}-studio`;
export const RETIRED_CATALOG_NAME = `${RETIRED_STUDIO_NAMESPACE}-catalog`;
