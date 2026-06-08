'use strict';
const bcrypt    = require('bcryptjs');

// ── PostgreSQL connection pool ─────────────────────────────────────────────────
// USE_PG_MEM=1 boots an in-memory PostgreSQL (for local previews — data is NOT saved).
// Otherwise connect to the real DATABASE_URL (Neon, etc.).
let pgPool;
if (process.env.USE_PG_MEM === '1') {
  const { newDb } = require('pg-mem');
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  pgPool = new adapter.Pool();
  console.log('  [pg-mem] In-memory PostgreSQL active (preview mode — data is not persisted)');
} else {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost/seedsads',
    ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
      ? { rejectUnauthorized: false }
      : false,
  });
}

// ── mysql2-compatible shim ─────────────────────────────────────────────────────
// Converts ? placeholders → $1,$2,… and normalises the return format to match
// mysql2's [rows, fields] for SELECT and [{ insertId, affectedRows }, []] for writes.
const pool = {
  async query(sql, params = []) {
    // Convert ? → $1, $2, …
    let i = 0;
    let pgSql = sql.replace(/\?/g, () => `$${++i}`);

    const isInsert = /^\s*INSERT\b/i.test(pgSql);

    // Inject RETURNING id so we get insertId back — but ONLY for plain INSERTs.
    // Skip when:
    //   • there's an ON CONFLICT clause (seed/upsert queries never read insertId, and
    //     tables like `settings` have no `id` column → RETURNING id would error)
    //   • a RETURNING clause is already present
    if (isInsert && !/ON\s+CONFLICT/i.test(pgSql) && !/\bRETURNING\b/i.test(pgSql)) {
      pgSql = pgSql.trimEnd().replace(/;$/, '') + ' RETURNING id';
    }

    const result = await pgPool.query(pgSql, params);

    if (isInsert) {
      return [{ insertId: result.rows[0]?.id ?? null, affectedRows: result.rowCount }, []];
    }
    if (/^\s*(UPDATE|DELETE)\b/i.test(pgSql)) {
      return [{ affectedRows: result.rowCount, changedRows: result.rowCount }, []];
    }
    return [result.rows, []];
  },
};

// ── Schema ────────────────────────────────────────────────────────────────────
async function createTables() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS admins (
      id         SERIAL PRIMARY KEY,
      username   VARCHAR(100) UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      name       VARCHAR(200) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id             SERIAL PRIMARY KEY,
      first_name     VARCHAR(100) NOT NULL,
      last_name      VARCHAR(100) NOT NULL,
      email          VARCHAR(200) UNIQUE NOT NULL,
      phone          VARCHAR(50),
      password       TEXT NOT NULL,
      plan           VARCHAR(100),
      payment_status VARCHAR(50) DEFAULT 'unpaid',
      approved       SMALLINT DEFAULT 0,
      approved_at    TIMESTAMP,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS payments (
      id               SERIAL PRIMARY KEY,
      user_id          INT NOT NULL,
      plan             VARCHAR(100),
      amount           VARCHAR(100),
      receipt_path     VARCHAR(500),
      receipt_filename VARCHAR(500),
      status           VARCHAR(50) DEFAULT 'pending',
      admin_note       TEXT,
      reviewed_by      INT,
      reviewed_at      TIMESTAMP,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS contacts (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(200) NOT NULL,
      email      VARCHAR(200) NOT NULL,
      phone      VARCHAR(50),
      service    VARCHAR(200),
      budget     VARCHAR(100),
      message    TEXT,
      status     VARCHAR(50) DEFAULT 'new',
      notes      TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS leads (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(200) NOT NULL,
      email      VARCHAR(200) NOT NULL,
      phone      VARCHAR(50),
      company    VARCHAR(200),
      plan       VARCHAR(100),
      status     VARCHAR(50) DEFAULT 'prospect',
      value      FLOAT DEFAULT 0,
      notes      TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS blog_posts (
      id          SERIAL PRIMARY KEY,
      title       VARCHAR(500) NOT NULL,
      slug        VARCHAR(600) UNIQUE NOT NULL,
      excerpt     TEXT,
      content     TEXT,
      category    VARCHAR(100),
      cover_image VARCHAR(500),
      status      VARCHAR(50) DEFAULT 'draft',
      author      VARCHAR(200) DEFAULT 'SeedsAds Team',
      author_id   INT,
      author_type VARCHAR(50) DEFAULT 'admin',
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key   VARCHAR(100) PRIMARY KEY,
      value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS page_views (
      id         SERIAL PRIMARY KEY,
      path       VARCHAR(300) NOT NULL,
      referrer   VARCHAR(300),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS dmi_content (
      id           SERIAL PRIMARY KEY,
      title        VARCHAR(500) NOT NULL,
      description  TEXT,
      type         VARCHAR(50) NOT NULL DEFAULT 'pdf',
      file_path    VARCHAR(500),
      file_name    VARCHAR(500),
      external_url VARCHAR(500),
      plan_access  VARCHAR(100) NOT NULL DEFAULT 'all',
      category     VARCHAR(100),
      sort_order   INT DEFAULT 0,
      published    SMALLINT DEFAULT 1,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS login_attempts (
      id         SERIAL PRIMARY KEY,
      identifier VARCHAR(200) NOT NULL,
      ip         VARCHAR(100),
      attempt_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id         SERIAL PRIMARY KEY,
      user_id    INT NOT NULL,
      token      VARCHAR(200) NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      used       SMALLINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS pricing_plans (
      id            SERIAL PRIMARY KEY,
      name          VARCHAR(100) NOT NULL,
      price         VARCHAR(50),
      billing       VARCHAR(50),
      description   TEXT,
      features      TEXT,
      is_popular    SMALLINT DEFAULT 0,
      badge_text    VARCHAR(100),
      badge_color   VARCHAR(200),
      button_text   VARCHAR(50) DEFAULT 'Get Started',
      button_style  VARCHAR(50) DEFAULT 'secondary',
      button_color  VARCHAR(200),
      register_plan VARCHAR(100),
      sort_order    INT DEFAULT 0,
      published     SMALLINT DEFAULT 1,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS faqs (
      id         SERIAL PRIMARY KEY,
      question   TEXT NOT NULL,
      answer     TEXT NOT NULL,
      category   VARCHAR(100),
      sort_order INT DEFAULT 0,
      published  SMALLINT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS team_members (
      id                SERIAL PRIMARY KEY,
      name              VARCHAR(200) NOT NULL,
      role              VARCHAR(200),
      bio               TEXT,
      photo_url         VARCHAR(500),
      team_type         VARCHAR(50) DEFAULT 'leadership',
      linkedin_url      VARCHAR(500),
      twitter_url       VARCHAR(500),
      other_social_icon VARCHAR(100),
      other_social_url  VARCHAR(500),
      sort_order        INT DEFAULT 0,
      published         SMALLINT DEFAULT 1,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS portfolio_items (
      id          SERIAL PRIMARY KEY,
      title       VARCHAR(200) NOT NULL,
      category    VARCHAR(100),
      description TEXT,
      icon        VARCHAR(100),
      image_url   VARCHAR(500),
      stat1_value VARCHAR(50),
      stat1_label VARCHAR(100),
      stat2_value VARCHAR(50),
      stat2_label VARCHAR(100),
      stat3_value VARCHAR(50),
      stat3_label VARCHAR(100),
      sort_order  INT DEFAULT 0,
      published   SMALLINT DEFAULT 1,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS case_studies (
      id          SERIAL PRIMARY KEY,
      title       VARCHAR(200) NOT NULL,
      category    VARCHAR(100),
      description TEXT,
      icon        VARCHAR(100),
      image_url   VARCHAR(500),
      stat1_value VARCHAR(50),
      stat1_label VARCHAR(100),
      stat2_value VARCHAR(50),
      stat2_label VARCHAR(100),
      stat3_value VARCHAR(50),
      stat3_label VARCHAR(100),
      sort_order  INT DEFAULT 0,
      published   SMALLINT DEFAULT 1,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS courses (
      id             SERIAL PRIMARY KEY,
      title          VARCHAR(200) NOT NULL,
      description    TEXT,
      level          VARCHAR(50),
      duration_hours INT DEFAULT 0,
      students       VARCHAR(50),
      icon           VARCHAR(100),
      gradient       VARCHAR(200),
      level_color    VARCHAR(50),
      sort_order     INT DEFAULT 0,
      published      SMALLINT DEFAULT 1,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS page_content (
      id         SERIAL PRIMARY KEY,
      page       VARCHAR(100) NOT NULL,
      section    VARCHAR(100) NOT NULL,
      content    TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (page, section)
    )`,
    `CREATE TABLE IF NOT EXISTS shop_products (
      id           SERIAL PRIMARY KEY,
      name         VARCHAR(200) NOT NULL,
      description  TEXT,
      category     VARCHAR(50) DEFAULT 'new',
      price        NUMERIC(12,2) DEFAULT 0,
      compare_at   NUMERIC(12,2),
      currency     VARCHAR(10) DEFAULT 'NGN',
      images       TEXT,
      badge        VARCHAR(50),
      sku          VARCHAR(100),
      in_stock     SMALLINT DEFAULT 1,
      sort_order   INT DEFAULT 0,
      published    SMALLINT DEFAULT 1,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS shop_orders (
      id             SERIAL PRIMARY KEY,
      reference      VARCHAR(120) UNIQUE NOT NULL,
      customer_name  VARCHAR(200),
      customer_email VARCHAR(200),
      customer_phone VARCHAR(50),
      items           TEXT,
      amount          NUMERIC(12,2) DEFAULT 0,
      currency        VARCHAR(10) DEFAULT 'NGN',
      gateway         VARCHAR(20),
      gateway_session VARCHAR(200),
      status          VARCHAR(20) DEFAULT 'pending',
      paid_at         TIMESTAMP,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS donations (
      id          SERIAL PRIMARY KEY,
      reference   VARCHAR(120) UNIQUE NOT NULL,
      donor_name  VARCHAR(200),
      donor_email VARCHAR(200),
      message     TEXT,
      amount      NUMERIC(12,2) DEFAULT 0,
      currency    VARCHAR(10) DEFAULT 'NGN',
      gateway     VARCHAR(20) DEFAULT 'flutterwave',
      status      VARCHAR(20) DEFAULT 'pending',
      paid_at     TIMESTAMP,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
  ];
  for (const sql of stmts) await pgPool.query(sql);
}

// ── Column migrations (add new columns to existing tables safely) ─────────────
// PostgreSQL 9.6+ supports ADD COLUMN IF NOT EXISTS (Neon uses pg 15+)
async function migrateColumns() {
  const migrations = [
    "ALTER TABLE team_members    ADD COLUMN IF NOT EXISTS photo_url  VARCHAR(500)",
    "ALTER TABLE portfolio_items ADD COLUMN IF NOT EXISTS image_url  VARCHAR(500)",
    "ALTER TABLE case_studies    ADD COLUMN IF NOT EXISTS image_url  VARCHAR(500)",
    "ALTER TABLE shop_orders     ADD COLUMN IF NOT EXISTS gateway_session VARCHAR(200)",
    "ALTER TABLE shop_orders     ADD COLUMN IF NOT EXISTS paid_at         TIMESTAMP",
  ];
  for (const sql of migrations) {
    try { await pgPool.query(sql); }
    catch (e) { console.warn('[migrateColumns]', e.message); }
  }
}

// ── Reset SERIAL sequences after explicit-ID seeding ─────────────────────────
// When we INSERT with explicit IDs the pg sequence doesn't advance.
// Call this after seeding so auto-generated IDs start after the seeded rows.
async function resetSequences() {
  const tables = ['pricing_plans', 'faqs', 'team_members', 'portfolio_items', 'case_studies', 'courses'];
  for (const t of tables) {
    try {
      await pgPool.query(
        `SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0))`
      );
    } catch (e) {
      console.warn(`[resetSequences] ${t}: ${e.message}`);
    }
  }
}

// ── Seed helpers ──────────────────────────────────────────────────────────────
async function seedAdmin() {
  const [rows] = await pool.query('SELECT id FROM admins WHERE username = ?', ['admin']);
  if (rows.length) return;
  let adminPass = process.env.ADMIN_PASSWORD;
  if (!adminPass) {
    adminPass = require('crypto').randomBytes(10).toString('hex');
    console.log('');
    console.log('  !! FIRST RUN: Admin account created !!');
    console.log('  Username: admin');
    console.log('  Password: ' + adminPass);
    console.log('  Change this immediately via the admin dashboard.');
    console.log('  Set ADMIN_PASSWORD in your .env to use a fixed password.');
    console.log('');
  }
  const hash = bcrypt.hashSync(adminPass, 12);
  await pool.query(
    'INSERT INTO admins (username, password, name) VALUES (?, ?, ?)',
    ['admin', hash, 'SeedsAds Admin']
  );
}

async function seedSettings() {
  const defaults = [
    ['site_name',     'SeedsAds Digital Marketing'],
    ['contact_email', 'hello@seedsads.com'],
    ['phone',         '+234 706 111 2102'],
    ['whatsapp',      '2347061112102'],
  ];
  for (const [k, v] of defaults) {
    await pool.query(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING',
      [k, v]
    );
  }
}

async function seedCms() {
  // ── Pricing Plans ────────────────────────────────────────────────────────
  const plans = [
    [1,'Starter','250,000','/month','Best for businesses testing and validating paid ads',
      JSON.stringify(['Meta Ads (Facebook & Instagram)','Campaign Strategy & Setup','Ad Spend Management (Up to ₦1,000,000/month)','Conversion Tracking (Pixel Setup)','Basic Funnel Guidance','Monthly Performance Report','Dedicated Account Support']),
      0,null,null,'Get Started','secondary',null,'Starter',1],
    [2,'Growth','700,000','/month','For businesses ready to scale and optimize performance',
      JSON.stringify(['Everything in Starter','Google Ads + Meta Ads','Ad Spend Management (Up to ₦3,000,000/month)','A/B Testing (Creatives & Copy)','Retargeting Campaigns','Funnel Optimization','Bi-weekly Reporting','Priority Support']),
      1,'Most Popular',null,'Get Started','primary',null,'Growth',2],
    [3,'DMI Course','150,000','/once','Full access to all SeedsAds Digital Marketing Institute courses',
      JSON.stringify(['Access to all DMI course materials','PDF guides, video lessons & templates','SEO, PPC, Social Media & Content modules','Email Marketing & Analytics courses','Digital Marketing certification','Lifetime access to course updates','Community support & career guidance']),
      0,'Digital Education','linear-gradient(135deg,#8b5cf6,#6366f1)','Enroll Now','custom','linear-gradient(135deg,#8b5cf6,#6366f1)','DMI Course',3],
    [4,'Enterprise','1,500,000','/month','For aggressive growth, scaling, and market dominance',
      JSON.stringify(['Everything in Growth','Multi-Platform Ads (Google, Meta, YouTube, TikTok)','Ad Spend Management (₦5,000,000+/month)','Advanced Funnel Strategy','Landing Page System (High-Converting Pages)','Conversion Rate Optimization (CRO)','Weekly Reporting & Insights','Dedicated Growth Manager']),
      0,null,null,'Get Started','secondary',null,'Enterprise',4],
  ];
  for (const r of plans) {
    await pool.query(
      `INSERT INTO pricing_plans (id,name,price,billing,description,features,is_popular,badge_text,badge_color,button_text,button_style,button_color,register_plan,sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`, r
    );
  }

  // ── FAQs ─────────────────────────────────────────────────────────────────
  const faqs = [
    [1,'What services does SeedsAds offer?','We offer a comprehensive range of digital marketing services including SEO, PPC advertising, social media marketing, content marketing, email marketing, analytics & CRO, lead generation, mobile marketing, and digital consultancy.','General Questions',1],
    [2,'How long does it take to see results?','Results vary depending on the service. PPC campaigns can generate traffic immediately, while SEO typically takes 3-6 months. We provide regular reports so you can track progress.','General Questions',2],
    [3,'Do you work with businesses of all sizes?','Yes! We work with startups, small businesses, mid-sized companies, and enterprise organizations. Our services are scalable and customizable to fit your specific needs.','General Questions',3],
    [4,'How is your pricing structured?','Our pricing varies by service and scope. We offer project-based pricing for one-time work and monthly retainers for ongoing services. Visit our pricing page for detailed information.','Pricing & Contracts',1],
    [5,'Do you require long-term contracts?','We offer flexible contract terms. While some services benefit from longer commitments (like SEO), we also offer month-to-month options for many services.','Pricing & Contracts',2],
    [6,'How do you communicate with clients?','You\'ll have a dedicated account manager, regular check-in calls, detailed monthly reports, and access to our project management system.','Working With Us',1],
    [7,'What makes SeedsAds different from other agencies?','We combine data-driven strategies with creative excellence. Our team stays ahead of industry trends, we provide transparent reporting, and we focus on measurable ROI.','Working With Us',2],
  ];
  for (const r of faqs) {
    await pool.query(
      'INSERT INTO faqs (id,question,answer,category,sort_order) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING', r
    );
  }

  // ── Team Members ─────────────────────────────────────────────────────────
  const team = [
    [1,'Sarah Johnson','CEO & Founder','With 15+ years in digital marketing, Sarah leads our vision and strategy.','leadership','#','#',null,null,1],
    [2,'Michael Chen','Chief Strategy Officer','Michael brings data-driven insights and strategic thinking to every client campaign.','leadership','#','#',null,null,2],
    [3,'Emily Rodriguez','Creative Director','Emily leads our creative team, crafting compelling brand stories.','leadership','#',null,'fab fa-dribbble','#',3],
    [4,'David Park','Head of Technology','David ensures our tech stack and analytics capabilities deliver cutting-edge solutions.','leadership','#',null,'fab fa-github','#',4],
    [5,'Jessica Williams','Head of SEO','SEO expert with a track record of ranking clients on page one.','department','#',null,null,null,1],
    [6,'James Thompson','Head of Paid Media','PPC specialist who has managed over $50M in ad spend with exceptional ROAS.','department','#',null,null,null,2],
    [7,'Amanda Foster','Head of Social Media','Social media strategist who has grown brand followings into millions of engaged fans.','department','#',null,null,null,3],
    [8,'Robert Kim','Head of Content','Content marketing expert who crafts narratives that convert readers into customers.','department','#',null,null,null,4],
  ];
  for (const r of team) {
    await pool.query(
      `INSERT INTO team_members (id,name,role,bio,team_type,linkedin_url,twitter_url,other_social_icon,other_social_url,sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`, r
    );
  }

  // ── Portfolio Items ───────────────────────────────────────────────────────
  const portfolio = [
    [1,'Harvesters','ecommerce','Complete digital transformation for an agricultural e-commerce platform.','fas fa-seedling','350%','Sales Growth','10x','ROAS','-40%','CPA',1],
    [2,'Konnect','saas','B2B lead generation campaign for a SaaS platform.','fas fa-plug','60%','Lower CPA','3x','Lead Volume','500%','ROI',2],
    [3,'GreenField Realty','realestate','Targeted Facebook campaigns for property sales.','fas fa-home','250%','More Leads','45%','Conversion','8x','ROAS',3],
    [4,'MedCare Plus','healthcare','Patient acquisition campaign for healthcare services.','fas fa-heartbeat','180%','Patient Inquiries','35%','Booking Rate','4x','ROAS',4],
    [5,'StyleHub','ecommerce','Fashion e-commerce growth campaign combining influencer marketing with paid ads.','fas fa-tshirt','420%','Revenue Growth','2.5M','Reach','6x','ROAS',5],
    [6,'FinEdge','saas','B2B financial services marketing bringing high-value enterprise clients.','fas fa-chart-pie','400%','B2B Leads','28%','Close Rate','6x','ROAS',6],
  ];
  for (const r of portfolio) {
    await pool.query(
      `INSERT INTO portfolio_items (id,title,category,description,icon,stat1_value,stat1_label,stat2_value,stat2_label,stat3_value,stat3_label,sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`, r
    );
  }

  // ── Case Studies ─────────────────────────────────────────────────────────
  const cases = [
    [1,'Fashion Retailer Transformation','ecommerce','How we helped a fashion retailer increase online sales by 340% through digital transformation.','fas fa-shopping-bag','340%','Sales Growth','5.2x','ROAS','180K','New Customers',1],
    [2,'Enterprise Lead Generation','b2b','Multi-channel lead generation strategy that increased qualified leads by 280%.','fas fa-building','280%','Lead Increase','-45%','Cost Per Lead','$2.4M','Pipeline Value',2],
    [3,'Healthcare Provider Growth','healthcare','Local SEO and patient acquisition strategies that increased bookings by 195%.','fas fa-heartbeat','195%','Bookings','4.8','Star Rating','12K','New Patients',3],
    [4,'SaaS Product Launch','saas','Go-to-market strategy achieving 10,000 signups in the first month.','fas fa-cloud','10K','Signups','25%','Conversion','$500K','MRR Achieved',4],
    [5,'Mobile App Marketing','ecommerce','500,000 app downloads through influencer partnerships and targeted campaigns.','fas fa-mobile-alt','500K','Downloads','$1.20','Cost/Install','35%','Retention',5],
    [6,'ABM Campaign Success','b2b','Account-based marketing targeting Fortune 500 companies resulting in 15 enterprise deals.','fas fa-chart-line','15','Enterprise Deals','$8M','ACV Won','32%','Win Rate',6],
  ];
  for (const r of cases) {
    await pool.query(
      `INSERT INTO case_studies (id,title,category,description,icon,stat1_value,stat1_label,stat2_value,stat2_label,stat3_value,stat3_label,sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`, r
    );
  }

  // ── Courses ───────────────────────────────────────────────────────────────
  const courses = [
    [1,'SEO Fundamentals','Learn the basics of search engine optimization and start improving your website\'s visibility.','Beginner',20,'5,200','fas fa-search','linear-gradient(135deg, #0A2540 0%, #0066FF 100%)','',1],
    [2,'Google Ads Mastery','Master Google Ads and create profitable campaigns that drive qualified traffic and conversions.','Intermediate',25,'3,800','fas fa-ad','linear-gradient(135deg, #ec4899, #f43f5e)','#ec4899',2],
    [3,'Social Media Marketing','Build a strong social media presence and engage your audience across all major platforms.','All Levels',30,'8,500','fas fa-share-alt','linear-gradient(135deg, #10b981, #34d399)','#10b981',3],
    [4,'Email Marketing Pro','Create high-converting email campaigns and build automated sequences that nurture leads.','Intermediate',18,'4,200','fas fa-envelope','linear-gradient(135deg, #f59e0b, #fbbf24)','#f59e0b',4],
    [5,'Marketing Analytics','Master data analysis and make data-driven marketing decisions that drive growth.','Advanced',35,'2,900','fas fa-chart-line','linear-gradient(135deg, #8b5cf6, #a78bfa)','',5],
    [6,'Content Marketing 101','Learn to create compelling content that attracts, engages, and converts your target audience.','Beginner',22,'6,100','fas fa-pen-fancy','linear-gradient(135deg, #06b6d4, #22d3ee)','#06b6d4',6],
  ];
  for (const r of courses) {
    await pool.query(
      `INSERT INTO courses (id,title,description,level,duration_hours,students,icon,gradient,level_color,sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`, r
    );
  }
}

async function seedShop() {
  // Only seed when the table is empty (avoids duplicates and explicit-id sequence issues)
  const [rows] = await pool.query('SELECT COUNT(*) AS c FROM shop_products');
  if (parseInt(rows[0].c) > 0) return;

  const img = (seed) => `https://picsum.photos/seed/${seed}/800/800`;
  const products = [
    // name, description, category, price, compare_at, images[], badge, in_stock, sort
    ['Pro Marketing Toolkit', 'A complete toolkit of templates, swipe files, and ad creatives to launch high-converting campaigns in minutes.', 'featured', 45000, 60000, [img('toolkit1'), img('toolkit2'), img('toolkit3'), img('toolkit4')], 'Best Value', 1, 1],
    ['Social Media Growth Pack', 'Done-for-you content calendar, 100+ post templates, and hashtag research across all major platforms.', 'trending', 30000, 40000, [img('social1'), img('social2'), img('social3')], null, 1, 2],
    ['SEO Mastery Course', 'Step-by-step video course on ranking #1 on Google, with downloadable checklists and audit templates.', 'best_seller', 55000, 75000, [img('seo1'), img('seo2'), img('seo3')], 'Top Rated', 1, 3],
    ['Brand Identity Kit', 'Logo templates, color palette guides, and brand style sheets to build a memorable brand in a weekend.', 'new', 25000, null, [img('brand1'), img('brand2'), img('brand3')], 'New', 1, 4],
    ['Email Funnel Blueprint', 'Plug-and-play email sequences proven to nurture leads and drive sales on autopilot.', 'hot', 35000, 50000, [img('email1'), img('email2'), img('email3')], 'Hot', 1, 5],
    ['Paid Ads Launch Bundle', 'Everything you need to launch profitable Meta and Google ads: targeting guides, creatives, and scaling playbooks.', 'featured', 65000, 90000, [img('ads1'), img('ads2'), img('ads3'), img('ads4')], 'Bundle', 1, 6],
  ];
  for (const [name, description, category, price, compare_at, images, badge, in_stock, sort_order] of products) {
    await pool.query(
      `INSERT INTO shop_products (name, description, category, price, compare_at, currency, images, badge, in_stock, sort_order, published)
       VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
      [name, description, category, price, compare_at, 'NGN', JSON.stringify(images), badge, in_stock, sort_order]
    );
  }
}

async function seedPageContent() {
  const upsert = async (page, section, content) => {
    await pool.query(
      'INSERT INTO page_content (page, section, content) VALUES (?,?,?) ON CONFLICT (page, section) DO NOTHING',
      [page, section, JSON.stringify(content)]
    );
  };

  // ── Homepage ──────────────────────────────────────────────────────────────
  await upsert('homepage', 'hero', {
    headline: 'We Grow Businesses Through',
    headline_highlight: 'Digital Power',
    subtitle: 'Data-driven digital marketing strategies that deliver measurable ROI. We turn clicks into customers and budgets into revenue.',
    cta1_text: 'Start Your Project', cta1_href: '#',
    cta2_text: 'View Our Work',      cta2_href: 'work/case-studies.html',
    stat1_value: '340%',  stat1_label: 'Average ROI Increase',
    stat2_value: '150+',  stat2_label: 'Global Clients',
    stat3_value: '12M+',  stat3_label: 'Leads Generated',
  });
  await upsert('homepage', 'services', {
    tag: 'Our Services', title: 'Full-Spectrum Digital Marketing',
    subtitle: 'From strategy to execution, we provide end-to-end solutions that drive growth across every digital channel.',
    items: [
      { icon: 'fas fa-search',    title: 'SEO Optimization',   desc: 'Dominate search rankings with our data-driven SEO strategies. Technical audits, content optimization, and authority building.',                                      link: 'services/seo.html' },
      { icon: 'fas fa-bullseye',  title: 'PPC Advertising',    desc: 'Maximize ROI with precision-targeted campaigns across Google Ads, Meta, LinkedIn, and emerging platforms.',                                                          link: 'services/ppc.html' },
      { icon: 'fas fa-share-nodes', title: 'Social Media',     desc: 'Build communities that convert. Strategic content, community management, and paid social that drives engagement.',                                                    link: 'services/social-media.html' },
      { icon: 'fas fa-pen-nib',   title: 'Content Strategy',   desc: 'Content that ranks and converts. From blog posts to video scripts, we create assets that fuel your funnel.',                                                         link: 'services/content-marketing.html' },
      { icon: 'fas fa-envelope',  title: 'Email Marketing',    desc: 'Automated nurture sequences and newsletters that turn subscribers into customers with personalized journeys.',                                                        link: 'services/email-marketing.html' },
      { icon: 'fas fa-chart-pie', title: 'Analytics & CRO',    desc: 'Data without action is wasted. We set up tracking, analyze behavior, and optimize for maximum conversions.',                                                         link: 'services/analytics.html' },
      { icon: 'fas fa-handshake', title: 'Digital Consultancy', desc: 'Strategic guidance for digital transformation. We help you navigate the digital landscape and achieve your business goals.',                                        link: 'services/consultancy.html' },
      { icon: 'fas fa-mobile-alt', title: 'Mobile Marketing',  desc: 'Reach customers on every device with SMS marketing, app promotion, and mobile-optimized campaigns.',                                                                link: 'services/mobile-marketing.html' },
    ],
  });
  await upsert('homepage', 'why_us', {
    tag: 'Why SeedsAds', title: 'Results-Driven Approach',
    subtitle: 'We combine creativity with analytics to deliver marketing that doesn\'t just look good—it performs.',
    cards: [
      { icon: 'fas fa-database',     title: 'Data-First Strategy', desc: 'Every decision is backed by data. We analyze market trends, competitor strategies, and audience behavior before crafting your unique approach.' },
      { icon: 'fas fa-puzzle-piece', title: 'Custom Solutions',    desc: 'No cookie-cutter templates. Your business is unique, and your marketing strategy should be too. We build bespoke campaigns for your goals.' },
      { icon: 'fas fa-trophy',       title: 'ROI Focused',         desc: 'Vanity metrics don\'t pay bills. We focus on the KPIs that matter: leads, conversions, revenue, and return on ad spend.' },
    ],
  });
  await upsert('homepage', 'process', {
    tag: 'Our Process', title: 'How We Deliver Success',
    subtitle: 'A proven methodology that takes you from strategy to scalable growth.',
    steps: [
      { number: '01', title: 'Discovery',  desc: 'Deep dive into your business, audience, and competitors' },
      { number: '02', title: 'Strategy',   desc: 'Custom roadmap aligned with your growth objectives' },
      { number: '03', title: 'Execution',  desc: 'Agile implementation with rapid testing and iteration' },
      { number: '04', title: 'Optimize',   desc: 'Continuous improvement based on performance data' },
    ],
  });
  await upsert('homepage', 'testimonials', {
    tag: 'Testimonials', title: 'Client Success Stories',
    subtitle: 'Don\'t just take our word for it—hear from the businesses we\'ve helped grow.',
    items: [
      { text: 'SeedsAds transformed our digital presence completely. Within 6 months, our organic traffic tripled and we\'re now ranking #1 for our most competitive keywords. Their team is professional, responsive, and truly understands digital marketing.', author_name: 'Harvesters Admin', author_role: 'Founder, Harvesters', avatar: 'HA', stars: 5 },
      { text: 'The ROI we\'ve seen from SeedsAds\' PPC campaigns is incredible. They reduced our cost per acquisition by 60% while scaling our lead volume. Their data-driven approach sets them apart from other agencies we\'ve worked with.', author_name: 'Konnect Team', author_role: 'Marketing Director, Konnect', avatar: 'KT', stars: 5 },
      { text: 'Finally, a marketing team that understands data. Their analytics-driven approach helped us identify opportunities we didn\'t know existed. SeedsAds doesn\'t just execute campaigns—they become a true partner in your growth.', author_name: 'SeedsAds Client', author_role: 'CEO, Growing Business', avatar: 'SA', stars: 5 },
    ],
  });
  await upsert('homepage', 'cta', {
    headline: 'Ready to Grow Your Business?',
    subtitle: 'Let\'s create a strategy that drives real, measurable results. Book your free consultation today.',
    btn_text: 'Book Free Consultation',
    btn_href: '#',
    phone: '+234 706 111 2102',
    email: 'Seedtv.com@gmail.com',
  });

  // ── About page ────────────────────────────────────────────────────────────
  await upsert('about', 'hero', {
    title: 'Our Company',
    subtitle: 'We\'re a team of passionate digital marketers dedicated to helping businesses grow through innovative strategies and data-driven solutions.',
  });
  await upsert('about', 'story', {
    title: 'Our Story',
    paragraphs: [
      'Founded in 2015, SeedsAds Digital Marketing began with a simple mission: to help businesses navigate the complex world of digital marketing and achieve measurable growth. What started as a small team of three passionate marketers has grown into a full-service digital agency with over 50 experts across multiple disciplines.',
      'Over the years, we\'ve had the privilege of working with hundreds of clients across diverse industries, from ambitious startups to Fortune 500 companies. Our approach combines creativity with data-driven insights, ensuring every campaign delivers tangible results.',
      'Today, we\'re proud to be recognized as an industry leader, known for our innovative strategies, transparent communication, and unwavering commitment to client success. But we\'re just getting started — our vision is to become the world\'s most trusted digital marketing partner.',
    ],
  });
  await upsert('about', 'stats', [
    { value: '500+', label: 'Clients Served' },
    { value: '50+',  label: 'Team Members' },
    { value: '9',    label: 'Years Experience' },
    { value: '25+',  label: 'Industry Awards' },
  ]);
  await upsert('about', 'values', {
    title: 'Our Core Values',
    subtitle: 'The principles that guide everything we do',
    cards: [
      { icon: 'fas fa-heart',       title: 'Client First',  desc: 'Your success is our success. We\'re committed to understanding your unique challenges and delivering solutions that drive real business growth.' },
      { icon: 'fas fa-lightbulb',   title: 'Innovation',    desc: 'We stay ahead of industry trends and continuously explore new technologies and strategies to give our clients a competitive edge.' },
      { icon: 'fas fa-chart-line',  title: 'Data-Driven',   desc: 'Every decision we make is backed by data and analytics. We believe in measurable results and transparent reporting.' },
      { icon: 'fas fa-handshake',   title: 'Integrity',     desc: 'We build lasting relationships based on trust, honesty, and ethical practices. No shortcuts, no black-hat tactics.' },
      { icon: 'fas fa-users',       title: 'Collaboration', desc: 'We work as an extension of your team, fostering open communication and partnership throughout every project.' },
      { icon: 'fas fa-trophy',      title: 'Excellence',    desc: 'We settle for nothing less than exceptional. Our team is dedicated to delivering work that exceeds expectations.' },
    ],
  });

  // ── Contact page ──────────────────────────────────────────────────────────
  await upsert('contact', 'hero', {
    title: 'Get In Touch',
    subtitle: 'Ready to transform your digital presence? Let\'s start a conversation.',
  });
  await upsert('contact', 'locations', [
    { name: 'Lagos, Nigeria',  address: '12 Tech Hub, Victoria Island, Lagos, Nigeria', phone: '+234 706 111 2102' },
    { name: 'London, UK',      address: '45 Digital Lane, London, EC2A 4DP, United Kingdom', phone: '' },
    { name: 'New York, USA',   address: '123 Marketing Street, Suite 100, New York, NY 10001, United States', phone: '' },
  ]);

  // ── Services pages ────────────────────────────────────────────────────────
  const servicePages = [
    { key: 'seo',             tag: 'SEO Services',          title: 'Search Engine Optimization', subtitle: 'Dominate search rankings with data-driven strategies that drive sustainable organic growth.',
      features: [
        { icon: 'fas fa-code',        title: 'Technical SEO',      desc: 'Complete technical audit and optimization including site speed, mobile-friendliness, crawlability, and structured data implementation.' },
        { icon: 'fas fa-pen-fancy',   title: 'On-Page Optimization', desc: 'Strategic keyword research, content optimization, meta tags, internal linking, and user experience improvements.' },
        { icon: 'fas fa-link',        title: 'Link Building',       desc: 'High-quality backlink acquisition through outreach, guest posting, digital PR, and content-driven link earning strategies.' },
        { icon: 'fas fa-map-marker',  title: 'Local SEO',           desc: 'Dominate local search results with optimized Google Business Profile, local citations, and location-specific content.' },
        { icon: 'fas fa-chart-line',  title: 'SEO Analytics',       desc: 'Track your progress with detailed reports on rankings, traffic, and conversions. Actionable insights to continuously improve performance.' },
      ],
      process: [
        { number: '1', title: 'Audit & Analysis',     desc: 'Comprehensive website audit to identify opportunities and issues affecting your rankings.' },
        { number: '2', title: 'Strategy Development', desc: 'Custom SEO roadmap based on your goals, competition, and target audience.' },
        { number: '3', title: 'Implementation',       desc: 'Execute on-page, off-page, and technical optimizations for maximum impact.' },
        { number: '4', title: 'Monitor & Improve',    desc: 'Continuous monitoring, reporting, and optimization to maintain and improve rankings.' },
      ],
      stats: [{ value: '300%', label: 'Avg. Traffic Increase' }, { value: '85%', label: 'Keywords on Page 1' }, { value: '150+', label: 'SEO Clients' }, { value: '10M+', label: 'Organic Visits Generated' }],
      cta: { headline: 'Ready to Rank Higher?', subtitle: 'Get a free SEO audit and discover how we can improve your search visibility.', btn_text: 'Get Free SEO Audit', btn_href: '../about/contact.html' },
    },
    { key: 'ppc',             tag: 'PPC Services',          title: 'PPC Advertising',            subtitle: 'Maximize ROI with precision-targeted paid campaigns that convert.',
      features: [
        { icon: 'fab fa-google',    title: 'Google Ads',        desc: 'Search, Display, Shopping, and YouTube campaigns fully managed for maximum ROI and quality score.' },
        { icon: 'fab fa-facebook',  title: 'Meta Ads',          desc: 'Facebook and Instagram campaigns with advanced audience targeting, retargeting, and creative optimization.' },
        { icon: 'fab fa-linkedin',  title: 'LinkedIn Ads',      desc: 'B2B campaigns targeting decision-makers with Sponsored Content, InMail, and Lead Gen Forms.' },
        { icon: 'fas fa-redo',      title: 'Remarketing',       desc: 'Re-engage website visitors and past customers with personalised ads that bring them back to convert.' },
        { icon: 'fas fa-chart-bar', title: 'PPC Analytics',     desc: 'Transparent reporting on spend, clicks, conversions, CPA, and ROAS — updated weekly.' },
      ],
      process: [
        { number: '1', title: 'Audit & Research',  desc: 'Analyse your current ads, competitors, and target audience.' },
        { number: '2', title: 'Campaign Build',    desc: 'Build campaigns with tight targeting, compelling copy, and conversion-focused landing pages.' },
        { number: '3', title: 'Launch & Test',     desc: 'Go live with A/B testing on creatives, audiences, and bids from day one.' },
        { number: '4', title: 'Optimise & Scale',  desc: 'Data-driven optimisation to lower CPA and scale the best-performing campaigns.' },
      ],
      stats: [{ value: '4.5x', label: 'Avg. ROAS' }, { value: '-40%', label: 'Avg. CPA Reduction' }, { value: '200+', label: 'PPC Clients' }, { value: '$50M+', label: 'Ad Spend Managed' }],
      cta: { headline: 'Ready to Launch Your Campaign?', subtitle: 'Get a free PPC audit and a custom strategy for your business.', btn_text: 'Get Free PPC Audit', btn_href: '../about/contact.html' },
    },
    { key: 'social-media',    tag: 'Social Media Services', title: 'Social Media Marketing',     subtitle: 'Build engaged communities that convert followers into loyal customers.',
      features: [
        { icon: 'fas fa-edit',        title: 'Content Creation',      desc: 'Eye-catching graphics, videos, reels, and copy crafted for each platform and audience.' },
        { icon: 'fas fa-calendar',    title: 'Content Calendar',      desc: 'Strategic content planning and scheduling to maintain consistent, on-brand posting.' },
        { icon: 'fas fa-comments',    title: 'Community Management',  desc: 'Active engagement — responding to comments, DMs, and building genuine audience relationships.' },
        { icon: 'fas fa-bullseye',    title: 'Paid Social',           desc: 'Meta, TikTok, and LinkedIn ad campaigns to amplify reach and drive targeted traffic.' },
        { icon: 'fas fa-chart-line',  title: 'Analytics & Reporting', desc: 'Monthly performance reports covering reach, engagement, follower growth, and conversions.' },
      ],
      process: [
        { number: '1', title: 'Brand Audit',       desc: 'Review your current presence and identify gaps and opportunities.' },
        { number: '2', title: 'Strategy',          desc: 'Develop platform-specific content strategies aligned with your business goals.' },
        { number: '3', title: 'Create & Publish',  desc: 'Produce and publish high-quality content consistently.' },
        { number: '4', title: 'Grow & Engage',     desc: 'Actively grow followers, manage community, and optimise for engagement.' },
      ],
      stats: [{ value: '2M+', label: 'Followers Grown' }, { value: '8x', label: 'Avg. Engagement Lift' }, { value: '120+', label: 'Social Clients' }, { value: '95%', label: 'Client Retention' }],
      cta: { headline: 'Ready to Grow Your Social Presence?', subtitle: 'Get a free social media audit today.', btn_text: 'Get Free Social Audit', btn_href: '../about/contact.html' },
    },
    { key: 'content-marketing', tag: 'Content Services', title: 'Content Marketing',           subtitle: 'Create content that ranks, resonates, and converts.',
      features: [
        { icon: 'fas fa-blog',        title: 'Blog Writing',        desc: 'SEO-optimized blog posts that establish authority and drive organic traffic.' },
        { icon: 'fas fa-video',       title: 'Video Scripts',       desc: 'Compelling video and reel scripts that capture attention and communicate your value.' },
        { icon: 'fas fa-envelope',    title: 'Email Copy',          desc: 'Persuasive email sequences and newsletters that nurture leads into customers.' },
        { icon: 'fas fa-file-alt',    title: 'White Papers & Guides', desc: 'Long-form lead magnets that generate qualified prospects and demonstrate expertise.' },
        { icon: 'fas fa-chart-line',  title: 'Content Analytics',   desc: 'Track content performance, organic traffic, time-on-page, and conversions.' },
      ],
      process: [
        { number: '1', title: 'Keyword & Topic Research', desc: 'Identify the topics and keywords your audience is actively searching for.' },
        { number: '2', title: 'Content Strategy',         desc: 'Build a content calendar aligned with your funnel and business goals.' },
        { number: '3', title: 'Create & Optimise',        desc: 'Produce high-quality content optimised for search and engagement.' },
        { number: '4', title: 'Promote & Measure',        desc: 'Distribute content across channels and track ROI.' },
      ],
      stats: [{ value: '3x', label: 'Avg. Organic Traffic Lift' }, { value: '60%', label: 'More Leads from Content' }, { value: '500+', label: 'Articles Published' }, { value: '92%', label: 'Client Satisfaction' }],
      cta: { headline: 'Ready to Build a Content Engine?', subtitle: 'Get a free content audit and strategy session.', btn_text: 'Get Free Content Audit', btn_href: '../about/contact.html' },
    },
    { key: 'email-marketing',  tag: 'Email Services',       title: 'Email Marketing',            subtitle: 'Turn your email list into a revenue-generating machine.',
      features: [
        { icon: 'fas fa-robot',       title: 'Marketing Automation', desc: 'Set up automated sequences that nurture leads and trigger personalised messages at the right moment.' },
        { icon: 'fas fa-envelope',    title: 'Newsletter Campaigns', desc: 'Beautifully designed, high-converting email newsletters your subscribers look forward to.' },
        { icon: 'fas fa-users',       title: 'List Segmentation',    desc: 'Segment your list by behaviour, demographics, and purchase history for laser-targeted messaging.' },
        { icon: 'fas fa-flask',       title: 'A/B Testing',          desc: 'Test subject lines, copy, design, and send times to continuously improve open and click rates.' },
        { icon: 'fas fa-chart-line',  title: 'Email Analytics',      desc: 'Detailed reporting on open rates, CTR, conversions, revenue attributed, and list health.' },
      ],
      process: [
        { number: '1', title: 'Audit & Strategy',    desc: 'Review your current email performance and build a results-driven strategy.' },
        { number: '2', title: 'Setup & Integration', desc: 'Configure your email platform, automation workflows, and opt-in forms.' },
        { number: '3', title: 'Create & Send',       desc: 'Design and send campaigns optimised for deliverability and engagement.' },
        { number: '4', title: 'Test & Optimise',     desc: 'Continuously A/B test and optimise based on performance data.' },
      ],
      stats: [{ value: '45%', label: 'Avg. Open Rate' }, { value: '12%', label: 'Avg. CTR' }, { value: '$42', label: 'Avg. ROI per $1 Spent' }, { value: '100+', label: 'Email Clients' }],
      cta: { headline: 'Ready to Unlock Email Revenue?', subtitle: 'Get a free email audit and see what\'s possible.', btn_text: 'Get Free Email Audit', btn_href: '../about/contact.html' },
    },
    { key: 'analytics',        tag: 'Analytics Services',   title: 'Analytics & CRO',            subtitle: 'Turn your data into decisions and your website into a conversion machine.',
      features: [
        { icon: 'fas fa-tachometer-alt', title: 'Analytics Setup',   desc: 'Full Google Analytics 4, Tag Manager, and conversion tracking implementation for accurate data.' },
        { icon: 'fas fa-funnel-dollar',  title: 'Funnel Analysis',   desc: 'Identify where users drop off and implement fixes that increase conversion rates at every stage.' },
        { icon: 'fas fa-flask',          title: 'A/B Testing',       desc: 'Test landing page variants, CTAs, headlines, and layouts to find what converts best.' },
        { icon: 'fas fa-desktop',        title: 'Heatmap & Session', desc: 'Heatmaps, scroll maps, and session recordings to understand real user behaviour.' },
        { icon: 'fas fa-file-chart-bar', title: 'Custom Dashboards', desc: 'Bespoke reporting dashboards that surface the KPIs that matter most to your business.' },
      ],
      process: [
        { number: '1', title: 'Audit',    desc: 'Full audit of your current tracking, data quality, and conversion funnel.' },
        { number: '2', title: 'Fix & Track', desc: 'Implement proper tracking and fix data gaps.' },
        { number: '3', title: 'Analyse', desc: 'Deep dive into the data to find conversion bottlenecks.' },
        { number: '4', title: 'Optimise', desc: 'Run experiments and deploy winning changes to lift conversions.' },
      ],
      stats: [{ value: '+35%', label: 'Avg. Conversion Lift' }, { value: '100%', label: 'Accurate Tracking' }, { value: '80+', label: 'CRO Projects' }, { value: '4.2x', label: 'Avg. ROAS Improvement' }],
      cta: { headline: 'Ready to Convert More Visitors?', subtitle: 'Get a free CRO audit and discover your biggest opportunities.', btn_text: 'Get Free CRO Audit', btn_href: '../about/contact.html' },
    },
    { key: 'consultancy',      tag: 'Consultancy Services', title: 'Digital Consultancy',         subtitle: 'Expert strategic guidance to navigate and win in the digital landscape.',
      features: [
        { icon: 'fas fa-map',          title: 'Digital Strategy',       desc: 'Comprehensive digital roadmap aligned with your business objectives and market opportunity.' },
        { icon: 'fas fa-search-dollar', title: 'Competitive Analysis', desc: 'Deep dive into your competitors\' digital strategies to identify gaps and opportunities.' },
        { icon: 'fas fa-users-cog',    title: 'Team Training',          desc: 'Upskill your internal marketing team with bespoke training and workshops.' },
        { icon: 'fas fa-tools',        title: 'Tech Stack Audit',       desc: 'Evaluate and optimise your marketing technology stack for efficiency and performance.' },
        { icon: 'fas fa-handshake',    title: 'Ongoing Advisory',       desc: 'Monthly strategic advisory sessions to keep your digital strategy sharp and ahead of trends.' },
      ],
      process: [
        { number: '1', title: 'Discovery',     desc: 'In-depth business and digital audit to understand where you are.' },
        { number: '2', title: 'Strategy',      desc: 'Build a tailored digital roadmap with clear priorities and quick wins.' },
        { number: '3', title: 'Implementation', desc: 'Support execution across your team or ours.' },
        { number: '4', title: 'Review & Adapt', desc: 'Regular review cycles to keep the strategy on track.' },
      ],
      stats: [{ value: '200+', label: 'Businesses Advised' }, { value: '92%', label: 'Strategy Success Rate' }, { value: '3x', label: 'Avg. Revenue Growth' }, { value: '15+', label: 'Industries Covered' }],
      cta: { headline: 'Ready for a Digital Transformation?', subtitle: 'Book a free strategy consultation.', btn_text: 'Book Free Consultation', btn_href: '../about/contact.html' },
    },
    { key: 'lead-generation',  tag: 'Lead Gen Services',    title: 'Lead Generation',             subtitle: 'Fill your pipeline with qualified leads that are ready to buy.',
      features: [
        { icon: 'fas fa-bullseye',    title: 'Multi-Channel Lead Gen', desc: 'Coordinated campaigns across Google, Meta, LinkedIn, and email to capture leads at every touchpoint.' },
        { icon: 'fas fa-landing-page', title: 'Landing Page Design',  desc: 'High-converting landing pages and funnels built specifically to maximise lead capture.' },
        { icon: 'fas fa-robot',       title: 'Lead Nurture Automation', desc: 'Automated follow-up sequences that keep prospects warm until they\'re ready to buy.' },
        { icon: 'fas fa-filter',      title: 'Lead Qualification',    desc: 'Scoring and qualification systems so your sales team only talks to the best prospects.' },
        { icon: 'fas fa-chart-line',  title: 'Pipeline Reporting',    desc: 'Track leads from source to close with transparent pipeline and revenue reporting.' },
      ],
      process: [
        { number: '1', title: 'ICP Definition',   desc: 'Define your ideal customer profile and highest-value audience segments.' },
        { number: '2', title: 'Funnel Build',     desc: 'Build campaigns, landing pages, and automation to capture and nurture leads.' },
        { number: '3', title: 'Launch & Test',    desc: 'Go live and rapidly test messaging, offers, and targeting.' },
        { number: '4', title: 'Scale',            desc: 'Scale what works, cut what doesn\'t, and grow your pipeline.' },
      ],
      stats: [{ value: '5x', label: 'Avg. Lead Volume Increase' }, { value: '-50%', label: 'Avg. Cost Per Lead' }, { value: '180+', label: 'Lead Gen Clients' }, { value: '2M+', label: 'Leads Generated' }],
      cta: { headline: 'Ready to Fill Your Pipeline?', subtitle: 'Get a free lead generation strategy session.', btn_text: 'Get Free Lead Gen Audit', btn_href: '../about/contact.html' },
    },
    { key: 'mobile-marketing', tag: 'Mobile Services',       title: 'Mobile Marketing',            subtitle: 'Reach and convert customers on their most-used device.',
      features: [
        { icon: 'fas fa-sms',         title: 'SMS Marketing',     desc: 'High-open-rate SMS campaigns for promotions, reminders, and re-engagement.' },
        { icon: 'fas fa-mobile-alt',  title: 'Mobile Ad Campaigns', desc: 'In-app ads, mobile display, and click-to-call campaigns optimised for mobile conversion.' },
        { icon: 'fas fa-download',    title: 'App Marketing',     desc: 'App store optimisation (ASO) and user acquisition campaigns to grow installs and engagement.' },
        { icon: 'fas fa-bell',        title: 'Push Notifications', desc: 'Personalised push notification strategies that re-engage users and drive repeat purchases.' },
        { icon: 'fas fa-chart-line',  title: 'Mobile Analytics',  desc: 'Track mobile-specific KPIs including app installs, in-app events, and mobile conversion rates.' },
      ],
      process: [
        { number: '1', title: 'Mobile Audit',   desc: 'Audit your current mobile presence and identify quick wins.' },
        { number: '2', title: 'Strategy',       desc: 'Build a mobile-first strategy covering ads, SMS, and app marketing.' },
        { number: '3', title: 'Launch',         desc: 'Execute campaigns with mobile-optimised creative and targeting.' },
        { number: '4', title: 'Optimise',       desc: 'Continuously improve based on mobile engagement and conversion data.' },
      ],
      stats: [{ value: '500K+', label: 'App Downloads Driven' }, { value: '98%', label: 'SMS Open Rate' }, { value: '3.5x', label: 'Mobile ROAS' }, { value: '80+', label: 'Mobile Clients' }],
      cta: { headline: 'Ready to Win on Mobile?', subtitle: 'Get a free mobile marketing audit.', btn_text: 'Get Free Mobile Audit', btn_href: '../about/contact.html' },
    },
  ];

  for (const svc of servicePages) {
    const { key, tag, title, subtitle, features, process, stats, cta } = svc;
    await upsert(`service-${key}`, 'hero',     { tag, title, subtitle });
    await upsert(`service-${key}`, 'features', { title: 'What We Do', subtitle: 'Comprehensive solutions tailored to your goals.', items: features });
    await upsert(`service-${key}`, 'process',  { title: 'Our Process', subtitle: 'A proven approach to delivering results.', steps: process });
    await upsert(`service-${key}`, 'stats',    stats);
    await upsert(`service-${key}`, 'cta',      cta);
  }

  // ── Blog page headers ─────────────────────────────────────────────────────
  await upsert('blog-articles',  'hero', { title: 'Latest Articles',    subtitle: 'Stay updated with the latest trends, strategies, and insights in digital marketing.' });
  await upsert('blog-tips',      'hero', { title: 'Marketing Tips',     subtitle: 'Actionable marketing tips and tactics you can implement today.' });
  await upsert('blog-insights',  'hero', { title: 'Industry Insights',  subtitle: 'Deep dives into digital marketing trends, data, and market analysis.' });
  await upsert('blog-guides',    'hero', { title: 'Free Guides',        subtitle: 'Comprehensive downloadable guides to level up your marketing.' });
}

// ── Public init function called by server.js ──────────────────────────────────
async function init() {
  await createTables();
  await migrateColumns();
  await seedAdmin();
  await seedSettings();
  await seedCms();
  await seedShop();
  await seedPageContent();
  await resetSequences();
}

module.exports = { pool, init };
