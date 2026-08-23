/**
 * propertyController.js
 *
 * GET /api/properties
 *   Filters: type, listingType, locality (multi, comma-sep), city,
 *            bhk (multi, comma-sep e.g. "2 BHK,3 BHK"),
 *            minPrice, maxPrice, bedrooms, bathrooms,
 *            furnishing, status, featured, search
 *   Sort:    newest | price-asc | price-desc | area-desc
 *   Pagination: page, limit
 */

import Property from '../models/Property.js';

const LIST_FIELDS =
  'title type listingType price priceLabel location city locality image images ' +
  'badge badgeColor status featured bedrooms bathrooms area parking ' +
  'agent yearBuilt developer rera coordinates createdAt furnishing';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/properties  — buyer-facing listing with filters
// ─────────────────────────────────────────────────────────────────────────────
export const getAllProperties = async (req, res) => {
  try {
    const {
      type,
      listingType,      // Buy | Rent | PG | Flatmates
      locality,         // comma-sep: "Baner,Kharadi"  (multi-select from frontend)
      city,             // legacy single city param
      bhk,              // comma-sep: "2 BHK,3 BHK"
      minPrice, maxPrice,
      bedrooms, bathrooms,
      furnishing, status,
      featured, search,
      sort  = 'newest',
      page  = 1,
      limit = 20,
    } = req.query;

    const filter = { isActive: true };

    // ── listingType (Buy / Rent / PG / Flatmates) ──────────────────────────
    if (listingType && listingType !== 'All') {
      // Normalise: frontend sends "rent" lowercase, model stores "Rent"
      const normalised = listingType.charAt(0).toUpperCase() + listingType.slice(1).toLowerCase();
      filter.listingType = normalised;
    }

    // ── Property type filter ─────────────────────────────────────────────────
    // Frontend sends: ?type=Plot (admin listings match) AND ?propertyType=Land/Plot (user listings match)
    // When both are sent, $or across both for full coverage.
    const { propertyType } = req.query;
    if ((type && type !== 'All') || (propertyType && propertyType !== 'All')) {
      const typeConditions = [];
      if (type && type !== 'All')                  typeConditions.push({ type: type });
      if (propertyType && propertyType !== 'All')  typeConditions.push({ propertyType: propertyType });
      // backward compat: if only one param sent, cross-check both fields
      if (type && !propertyType)                   typeConditions.push({ propertyType: type });
      if (propertyType && !type)                   typeConditions.push({ type: propertyType });
      // dedupe
      const seen = new Set();
      const uniqueConditions = typeConditions.filter(c => {
        const key = JSON.stringify(c); if (seen.has(key)) return false; seen.add(key); return true;
      });
      if (filter.$and) {
        filter.$and.push({ $or: uniqueConditions });
      } else if (filter.$or) {
        const existing = filter.$or;
        delete filter.$or;
        filter.$and = [{ $or: existing }, { $or: uniqueConditions }];
      } else {
        filter.$or = uniqueConditions;
      }
    }

    // ── Locality — multi-value, comma-separated ───────────────────────────────
    // Priority: locality param > legacy city param
    if (locality && locality !== 'All') {
      const locs = locality.split(',').map(l => l.trim()).filter(Boolean);
      if (locs.length === 1) {
        // Single locality: try exact match on locality field first,
        // then fall back to regex on location string
        filter.$or = [
          { locality: { $regex: locs[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
          { location: { $regex: locs[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
        ];
      } else {
        // Multiple localities: $or across all
        filter.$or = locs.flatMap(l => {
          const safe = l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return [
            { locality: { $regex: safe, $options: 'i' } },
            { location: { $regex: safe, $options: 'i' } },
          ];
        });
      }
    } else if (city && city !== 'All') {
      // Legacy city filter (kept for backward compat)
      const safe = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { city:     { $regex: safe, $options: 'i' } },
        { locality: { $regex: safe, $options: 'i' } },
        { location: { $regex: safe, $options: 'i' } },
      ];
    }

    // ── BHK — multi-value, comma-separated ("2 BHK,3 BHK") ──────────────────
    if (bhk) {
      const bhkValues = bhk.split(',').map(b => b.trim()).filter(Boolean);
      if (bhkValues.length) {
        // For user listings: match exact bhkType string ("1 BHK", "1 RK" etc.)
        // For admin listings: match bedrooms number (bhkType field not present)
        const bhkConditions = bhkValues.map(b => {
          if (b === '4+ BHK') {
            return {
              $or: [
                { bhkType: { $exists: false }, bedrooms: { $gte: 4 } }, // admin listing
                { bhkType: b },                                           // user listing
              ],
            };
          }
          const n = parseInt(b);
          return {
            $or: [
              { bhkType: b },                                             // user listing — exact match e.g. "1 BHK" or "1 RK"
              { bhkType: { $exists: false }, bedrooms: isNaN(n) ? 0 : n }, // admin listing — no bhkType, use bedrooms number
            ],
          };
        }).filter(Boolean);

        if (bhkConditions.length === 1) {
          const cond = bhkConditions[0];
          if (filter.$and) {
            filter.$and.push(cond);
          } else if (filter.$or) {
            const existing = filter.$or;
            delete filter.$or;
            filter.$and = [{ $or: existing }, cond];
          } else {
            Object.assign(filter, cond);
          }
        } else if (bhkConditions.length > 1) {
          const multiCond = { $or: bhkConditions };
          if (filter.$and) {
            filter.$and.push(multiCond);
          } else if (filter.$or) {
            const existing = filter.$or;
            delete filter.$or;
            filter.$and = [{ $or: existing }, multiCond];
          } else {
            filter.$or = bhkConditions;
          }
        }
      }
    } else if (bedrooms && bedrooms !== 'Any') {
      // Legacy single bedrooms param
      const n = Number(bedrooms);
      filter.bedrooms = n >= 4 ? { $gte: 4 } : n;
    }

    // ── Bathrooms ─────────────────────────────────────────────────────────────
    if (bathrooms && bathrooms !== 'Any') {
      filter.bathrooms = { $gte: Number(bathrooms) };
    }

    // ── Price range ───────────────────────────────────────────────────────────
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    // ── adType → listingType (frontend sends adType, model stores listingType) ──
    const resolvedAdType = req.query.adType || listingType;
    if (resolvedAdType && resolvedAdType !== 'All') {
      const norm = resolvedAdType.charAt(0).toUpperCase() + resolvedAdType.slice(1).toLowerCase();
      // Special cases: PG/Hostel, Flatmates casing preserve karo
      const adTypeMap = {
        'Pg/hostel': 'PG/Hostel',
        'Flatmates': 'Flatmates',
        'Resale':    'Resale',
        'Rent':      'Rent',
        'Sale':      'Sale',
      };
      filter.listingType = adTypeMap[norm] || norm;
    }

    // ── Furnishing — comma-sep multi value support ────────────────────────────
    if (furnishing && furnishing !== 'Any') {
      const vals = furnishing.split(',').map(f => f.trim()).filter(Boolean);
      filter.furnishing = vals.length === 1 ? vals[0] : { $in: vals };
    }

    // ── Facing — comma-sep multi value ───────────────────────────────────────
    const { facing, propertyAge, possession, tenantPref } = req.query;
    if (facing) {
      const vals = facing.split(',').map(f => f.trim()).filter(Boolean);
      if (vals.length) filter.facing = vals.length === 1 ? vals[0] : { $in: vals };
    }

    // ── Property Age ──────────────────────────────────────────────────────────
    if (propertyAge) filter.propertyAge = propertyAge;

    // ── Possession / Available From ───────────────────────────────────────────
    if (possession) filter.availableFrom = possession;

    // ── Preferred Tenant ──────────────────────────────────────────────────────
    if (tenantPref) filter.preferredTenant = tenantPref;

    // ── Extended filters ──────────────────────────────────────────────────────
    const { pgGender, roomType, pgFood, buildingType, tenantType, parkingType, minArea, maxArea } = req.query;
    if (pgGender)     filter.pgGender    = pgGender;
    if (roomType)     filter.roomType    = roomType;
    if (pgFood)       filter.pgFood      = { $regex: pgFood, $options: 'i' }; // "Breakfast" matches "Breakfast,Lunch,Dinner"
    if (buildingType) filter.buildingType = buildingType;
    if (tenantType)   filter.tenantType  = tenantType;
    if (parkingType)  filter.parkingType = parkingType;

    // ── Area range (for commercial/plot) ─────────────────────────────────────
    if (minArea || maxArea) {
      filter.area = {};
      if (minArea) filter.area.$gte = Number(minArea);
      if (maxArea) filter.area.$lte = Number(maxArea);
    }

    // ── Parking (number) ──────────────────────────────────────────────────────
    const { minParking } = req.query;
    if (minParking) filter.parking = { $gte: Number(minParking) };

    // ── Status (Ready to Move / Under Construction …) ─────────────────────────
    if (status && status !== 'Any') filter.status = status;

    // ── Featured ──────────────────────────────────────────────────────────────
    if (featured === 'true') filter.featured = true;

    // ── Text search ───────────────────────────────────────────────────────────
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchOr = [
        { title:    { $regex: safe, $options: 'i' } },
        { location: { $regex: safe, $options: 'i' } },
        { locality: { $regex: safe, $options: 'i' } },
        { city:     { $regex: safe, $options: 'i' } },
        { developer:{ $regex: safe, $options: 'i' } },
      ];
      // Merge with existing $or/$and safely
      if (filter.$and) {
        filter.$and.push({ $or: searchOr });
      } else if (filter.$or) {
        const existing = filter.$or;
        delete filter.$or;
        filter.$and = [{ $or: existing }, { $or: searchOr }];
      } else {
        filter.$or = searchOr;
      }
    }

    // ── Sort ──────────────────────────────────────────────────────────────────
    const sortMap = {
      newest:       { createdAt: -1 },
      'price-asc':  { price:  1 },
      'price-desc': { price: -1 },
      'area-desc':  { area:  -1 },
    };
    const sortObj = sortMap[sort] || { createdAt: -1 };

    const skip = (Number(page) - 1) * Number(limit);

    const [total, properties] = await Promise.all([
      Property.countDocuments(filter),
      Property.find(filter)
        .select(LIST_FIELDS)
        .sort(sortObj)
        .skip(skip)
        .limit(Number(limit))
        .lean(),
    ]);

    // Ensure image field is always set (fallback to images[0] for user-posted properties)
    const normalized = properties.map(p => {
      const obj = p;
      if (!obj.image && obj.images && obj.images.length > 0) {
        obj.image = obj.images[0];
      }
      return obj;
    });

    return res.status(200).json({
      success: true,
      total,
      count: normalized.length,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit)),
      properties: normalized,
    });
  } catch (error) {
    console.error('getAllProperties error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/properties/:id
// ─────────────────────────────────────────────────────────────────────────────
export const getPropertyById = async (req, res) => {
  try {
    const property = await Property
      .findOne({ _id: req.params.id, isActive: true })
      .lean();
    if (!property) {
      return res.status(404).json({ success: false, message: 'Property not found' });
    }
    property.image = property.image || property.images?.[0] || '';
    return res.status(200).json({ success: true, property });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/properties  (admin only)
// ─────────────────────────────────────────────────────────────────────────────
export const createProperty = async (req, res) => {
  try {
    const { title, type, price, location, city } = req.body;
    if (!title || !type || !price || !location || !city) {
      return res.status(400).json({
        success: false,
        message: 'title, type, price, location and city are required',
      });
    }
    const property = await Property.create({
      ...req.body,
      addedBy: {
        role: req.user?.role || 'admin',
        name: req.user?.name || '',
      },
    });
    return res.status(201).json({ success: true, property });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/properties/:id  (admin only)
// ─────────────────────────────────────────────────────────────────────────────
export const updateProperty = async (req, res) => {
  try {
    const property = await Property.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!property) {
      return res.status(404).json({ success: false, message: 'Property not found' });
    }
    property.image = property.image || property.images?.[0] || '';
    return res.status(200).json({ success: true, property });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/properties/:id  (admin only — soft delete)
// ─────────────────────────────────────────────────────────────────────────────
export const deleteProperty = async (req, res) => {
  try {
    const property = await Property.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );
    if (!property) {
      return res.status(404).json({ success: false, message: 'Property not found' });
    }
    return res.status(200).json({ success: true, message: 'Property removed from listings' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/properties/counts  — property counts by type and locality
// ─────────────────────────────────────────────────────────────────────────────
export const getPropertyCounts = async (req, res) => {
  try {
    const typeMap = {
      'Villa':      'Luxury Villas',
      'Apartment':  'Apartments',
      'Penthouse':  'Penthouses',
      'Commercial': 'Commercial',
      'Farm House': 'Farm Houses',
      'Plot':       'Plots',
    };

    const localities = [
      'Balewadi', 'Hadapsar', 'KP', 'NIBM Road', 'Viman Nagar', 'Kharadi',
      'Punewadi', 'Kothrud', 'Karve Nagar', 'Shewalewadi Road', 'Baner',
      'Pashan', 'Bawadhan', 'MG Road', 'JM Road', 'F.C. Road',
      'Hinjewadi Phase I, II', 'Ravet', 'Ganga Dham Chownk', 'Swargate',
      'Katraj', 'Prabhat Road',
    ];

    const [typeAgg, localityAgg] = await Promise.all([
      Property.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
      ]),
      Property.aggregate([
        { $match: { isActive: true } },
        {
          $group: {
            _id: null,
            ...Object.fromEntries(
              localities.map((loc) => [
                `loc_${loc.replace(/[^a-zA-Z0-9]/g, '_')}`,
                {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $regexMatch: { input: '$location', regex: loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' } },
                          { $regexMatch: { input: { $ifNull: ['$locality', ''] }, regex: loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' } },
                        ],
                      },
                      1, 0,
                    ],
                  },
                },
              ])
            ),
          },
        },
      ]),
    ]);

    const typeCounts = {};
    typeAgg.forEach(({ _id, count }) => {
      const category = typeMap[_id] || _id;
      typeCounts[category] = (typeCounts[category] || 0) + count;
    });

    const localityCounts = {};
    const rawLocality = localityAgg[0] || {};
    localities.forEach((loc) => {
      const key = `loc_${loc.replace(/[^a-zA-Z0-9]/g, '_')}`;
      localityCounts[loc] = rawLocality[key] || 0;
    });

    return res.status(200).json({ success: true, typeCounts, localityCounts });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
