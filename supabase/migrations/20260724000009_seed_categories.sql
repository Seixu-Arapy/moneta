-- Seed initial categories with common expense types

-- Insert root categories
insert into public.categories (name, slug, description, icon, color, sort_order, is_active)
values
  ('🏠 Housing', 'housing', 'Rent, mortgage, utilities, property tax', '🏠', 'blue-500', 10, true),
  ('🛒 Groceries & Food', 'food', 'Supermarkets, restaurants, food delivery', '🛒', 'amber-500', 20, true),
  ('🚗 Transportation', 'transportation', 'Gas, car maintenance, public transit, parking', '🚗', 'slate-500', 30, true),
  ('💼 Work & Education', 'work', 'Career development, courses, professional services', '💼', 'purple-500', 40, true),
  ('🏥 Health & Fitness', 'health', 'Medical, pharmacy, gym, wellness', '🏥', 'rose-500', 50, true),
  ('🎉 Entertainment', 'entertainment', 'Movies, concerts, hobbies, events', '🎉', 'fuchsia-500', 60, true),
  ('👔 Clothing & Accessories', 'clothing', 'Clothes, shoes, fashion, personal care', '👔', 'indigo-500', 70, true),
  ('🪴 Home & Garden', 'home', 'Furniture, decor, maintenance, tools', '🪴', 'green-500', 80, true),
  ('🚀 Technology & Subscriptions', 'tech', 'Software, apps, internet, gadgets', '🚀', 'cyan-500', 90, true),
  ('📚 Gifts & Donations', 'gifts', 'Charitable giving, gifts to others', '📚', 'pink-500', 100, true)
on conflict (slug) do nothing;

-- Insert subcategories
insert into public.categories (name, slug, description, parent_id, icon, color, sort_order, is_active)
select t.name, t.slug, t.description, c.id, t.icon, t.color, t.sort_order, true
from (
  values
    -- Housing
    ('Rent / Mortgage', 'rent', 'Monthly housing payment', 'housing', '🏠', 'blue-600', 1),
    ('Utilities', 'utilities', 'Electricity, water, gas, internet', 'housing', '⚡', 'blue-400', 2),
    ('Maintenance & Repairs', 'home-maintenance', 'Repairs, cleaning, property upkeep', 'housing', '🔧', 'blue-300', 3),
    ('Property Tax', 'property-tax', 'Annual property tax', 'housing', '📋', 'blue-200', 4),

    -- Food
    ('Supermarket', 'supermarket', 'Grocery shopping', 'food', '🛒', 'amber-600', 1),
    ('Restaurants', 'restaurants', 'Dining out', 'food', '🍽️', 'amber-500', 2),
    ('Delivery', 'food-delivery', 'Food delivery services', 'food', '🚚', 'amber-400', 3),
    ('Bakery & Cafe', 'bakery', 'Coffee shops, bakeries', 'food', '☕', 'amber-300', 4),

    -- Transportation
    ('Gas / Fuel', 'gas', 'Petrol, diesel', 'transportation', '⛽', 'slate-600', 1),
    ('Car Maintenance', 'car-maintenance', 'Oil changes, repairs, inspection', 'transportation', '🔧', 'slate-500', 2),
    ('Public Transit', 'transit', 'Bus, train, metro passes', 'transportation', '🚌', 'slate-400', 3),
    ('Parking', 'parking', 'Parking fees, garage', 'transportation', '🅿️', 'slate-300', 4),
    ('Ride-sharing', 'rideshare', 'Uber, Lyft, taxi', 'transportation', '🚕', 'slate-200', 5),

    -- Work & Education
    ('Courses & Training', 'courses', 'Online courses, workshops', 'work', '📚', 'purple-600', 1),
    ('Professional Services', 'professional', 'Consulting, legal, accounting', 'work', '👨‍💼', 'purple-500', 2),
    ('Books & Materials', 'books', 'Learning materials', 'work', '📖', 'purple-400', 3),

    -- Health
    ('Medical & Hospital', 'medical', 'Doctor visits, hospital, surgery', 'health', '⚕️', 'rose-600', 1),
    ('Pharmacy', 'pharmacy', 'Medications, supplements', 'health', '💊', 'rose-500', 2),
    ('Gym & Fitness', 'gym', 'Gym membership, classes', 'health', '💪', 'rose-400', 3),
    ('Mental Health', 'therapy', 'Therapy, counseling, wellness', 'health', '🧠', 'rose-300', 4),

    -- Entertainment
    ('Movies & Cinema', 'cinema', 'Movie tickets, film subscriptions', 'entertainment', '🎬', 'fuchsia-600', 1),
    ('Concerts & Events', 'events', 'Concert tickets, shows', 'entertainment', '🎵', 'fuchsia-500', 2),
    ('Gaming', 'gaming', 'Games, gaming subscriptions', 'entertainment', '🎮', 'fuchsia-400', 3),
    ('Hobbies', 'hobbies', 'Sports equipment, craft supplies', 'entertainment', '🎯', 'fuchsia-300', 4),

    -- Clothing
    ('Clothes', 'clothes', 'Apparel, fashion', 'clothing', '👗', 'indigo-600', 1),
    ('Shoes & Footwear', 'shoes', 'Shoes, boots, sandals', 'clothing', '👟', 'indigo-500', 2),
    ('Personal Care', 'personal-care', 'Hair, beauty, grooming', 'clothing', '💄', 'indigo-400', 3),

    -- Home & Garden
    ('Furniture', 'furniture', 'Furniture, fixtures', 'home', '🛋️', 'green-600', 1),
    ('Decor & Accessories', 'decor', 'Home decor items', 'home', '🖼️', 'green-500', 2),
    ('Tools & Equipment', 'tools', 'Power tools, hand tools', 'home', '🔨', 'green-400', 3),
    ('Garden & Outdoor', 'garden', 'Plants, seeds, gardening', 'home', '🌱', 'green-300', 4),

    -- Technology
    ('Software & Apps', 'software', 'Software licenses, apps', 'tech', '💻', 'cyan-600', 1),
    ('Internet & Phone', 'internet', 'Internet service, phone bill', 'tech', '📡', 'cyan-500', 2),
    ('Hardware & Gadgets', 'hardware', 'Computers, phones, accessories', 'tech', '⌨️', 'cyan-400', 3),
    ('Streaming Services', 'streaming', 'Netflix, Spotify, etc.', 'tech', '📺', 'cyan-300', 4),

    -- Gifts & Donations
    ('Gifts to Others', 'gifts-personal', 'Presents, gifts', 'gifts', '🎁', 'pink-600', 1),
    ('Charitable Giving', 'donations', 'Donations, charity', 'gifts', '🤝', 'pink-500', 2)
) t(name, slug, description, parent_slug, icon, color, sort_order)
join public.categories c on c.slug = t.parent_slug
where c.parent_id is null  -- Only join with root categories
on conflict (slug) do nothing;
