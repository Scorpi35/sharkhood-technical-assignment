import { z } from 'zod';

/*
 * Zod schemas for the three xbyte raw collections (see docs/DATA_ANALYSIS.md §1).
 * z.object() strips unknown keys, so `endpoint` and `payload.request_log` (which
 * carry the API key) never survive validation. Only fields we use are declared.
 */

const id = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/, 'expected a numeric id')]);
const numberish = z.union([z.number(), z.string()]).nullable().optional();
const optionalText = z.string().nullable().optional();

/** Shared envelope: `domain` is the platform; `createdAt` is the source timestamp. */
export const envelopeSchema = z.object({
  domain: z.string().min(1),
  createdAt: z.date(),
});

// ------------------------------------------------------------------ locations

export const locationRowSchema = z.object({
  location_id: id,
  location_name: z.string(),
  location_slug: z.string(),
});

export const locationsDocSchema = envelopeSchema.extend({
  payload: z.object({ results: z.array(locationRowSchema).min(1) }),
});
export type LocationsDoc = z.infer<typeof locationsDocSchema>;

// ------------------------------------------------------------------ restaurants (area listing pages)

/** restaurant_url is only required to be a string here: a URL that does not parse is a record-level issue. */
export const listingRowSchema = z.object({
  area_name: z.string(),
  restaurant_name: z.string(),
  restaurant_url: z.string(),
});

export const restaurantsDocSchema = envelopeSchema.extend({
  params: z.object({
    areaSlug: z.string(),
    areaId: id, // a string in the data ("1468"); keyed as a canonical string
    page_no: z.number().int().nonnegative(),
  }),
  payload: z.object({ results: z.array(listingRowSchema).min(1) }),
});
export type RestaurantsDoc = z.infer<typeof restaurantsDocSchema>;
export type ListingRow = z.infer<typeof listingRowSchema>;

// ------------------------------------------------------------------ menus

export const menuItemSchema = z.object({
  item_id: id,
  item_name: z.string(),
  description: optionalText,
  price: z.number(),
  rating: z.number().nullable().optional(),
  image: optionalText,
});

export const menuCategorySchema = z.object({
  category_id: id,
  category_name: z.string(),
  items: z.array(menuItemSchema),
});

/** Key naming is the provider's: camelCase, PascalCase and spaces all appear. */
export const menuRestaurantSchema = z.object({
  id,
  name: z.string(),
  logo: optionalText,
  latitude: numberish,
  longitude: numberish,
  rate: z.number().nullable().optional(),
  totalRatings: z.number().nullable().optional(),
  deliveryFee: numberish,
  DeliveryTime: optionalText,
  'Minimum Order': numberish,
  'Restaurant Address': optionalText,
  City: optionalText,
  Contact: optionalText,
  outletCode: id,
  category: z.array(menuCategorySchema),
});

export const menusDocSchema = envelopeSchema.extend({
  params: z.object({ restaurant_url: z.string() }),
  payload: z.object({ results: z.array(menuRestaurantSchema).length(1, 'expected exactly one restaurant in results') }),
});
export type MenusDoc = z.infer<typeof menusDocSchema>;
export type MenuRestaurant = z.infer<typeof menuRestaurantSchema>;
export type MenuCategory = z.infer<typeof menuCategorySchema>;
export type MenuItem = z.infer<typeof menuItemSchema>;
