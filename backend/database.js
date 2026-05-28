'use strict';
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

const isLocal =
  !process.env.DATABASE_URL ||
  process.env.DATABASE_URL.includes('localhost') ||
  process.env.DATABASE_URL.includes('127.0.0.1');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

// ── Schema ────────────────────────────────────────────────────────────────────
async function createTables() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      password TEXT NOT NULL,
      plan TEXT,
      payment_status TEXT DEFAULT 'unpaid',
      approved INTEGER DEFAULT 0,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT,
      amount TEXT,
      receipt_path TEXT,
      receipt_filename TEXT,
      status TEXT DEFAULT 'pending',
      admin_note TEXT,
      reviewed_by INTEGER,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      service TEXT,
      budget TEXT,
      message TEXT,
      status TEXT DEFAULT 'new',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      company TEXT,
      plan TEXT,
      status TEXT DEFAULT 'prospect',
      value REAL DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS blog_posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      excerpt TEXT,
      content TEXT,
      category TEXT,
      cover_image TEXT,
      status TEXT DEFAULT 'draft',
      author TEXT DEFAULT 'SeedsAds Team',
      author_id INTEGER,
      author_type TEXT DEFAULT 'admin',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS page_views (
      id SERIAL PRIMARY KEY,
      path TEXT NOT NULL,
      referrer TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS dmi_content (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL DEFAULT 'pdf',
      file_path TEXT,
      file_name TEXT,
      external_url TEXT,
      plan_access TEXT NOT NULL DEFAULT 'all',
      category TEXT,
      sort_order INTEGER DEFAULT 0,
      published INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS login_attempts (
      id SERIAL PRIMARY KEY,
      identifier TEXT NOT NULL,
      ip TEXT,
      attempt_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS pricing_plans (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price TEXT,
      billing TEXT,
      description TEXT,
      features TEXT,
      is_popular INTEGER DEFAULT 0,
      badge_text TEXT,
      badge_color TEXT,
      button_text TEXT DEFAULT 'Get Started',
      button_style TEXT DEFAULT 'secondary',
      button_color TEXT,
      register_plan TEXT,
      sort_order INTEGER DEFAULT 0,
      published INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS faqs (
      id SERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      category TEXT,
      sort_order INTEGER DEFAULT 0,
      published INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS team_members (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      bio TEXT,
      team_type TEXT DEFAULT 'leadership',
      linkedin_url TEXT,
      twitter_url TEXT,
      other_social_icon TEXT,
      other_social_url TEXT,
      sort_order INTEGER DEFAULT 0,
      published INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS portfolio_items (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT,
      description TEXT,
      icon TEXT,
      stat1_value TEXT,
      stat1_label TEXT,
      stat2_value TEXT,
      stat2_label TEXT,
      stat3_value TEXT,
      stat3_label TEXT,
      sort_order INTEGER DEFAULT 0,
      published INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS case_studies (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT,
      description TEXT,
      icon TEXT,
      stat1_value TEXT,
      stat1_label TEXT,
      stat2_value TEXT,
      stat2_label TEXT,
      stat3_value TEXT,
      stat3_label TEXT,
      sort_order INTEGER DEFAULT 0,
      published INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS courses (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      level TEXT,
      duration_hours INTEGER DEFAULT 0,
      students TEXT,
      icon TEXT,
      gradient TEXT,
      level_color TEXT,
      sort_order INTEGER DEFAULT 0,
      published INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
  ];
  for (const sql of stmts) await pool.query(sql);
}

// ── Seed helpers ──────────────────────────────────────────────────────────────
async function seedAdmin() {
  const { rows } = await pool.query('SELECT id FROM admins WHERE username = $1', ['admin']);
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
    'INSERT INTO admins (username, password, name) VALUES ($1, $2, $3)',
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
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
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
  for (const [id,name,price,billing,description,features,is_popular,badge_text,badge_color,button_text,button_style,button_color,register_plan,sort_order] of plans) {
    await pool.query(
      `INSERT INTO pricing_plans (id,name,price,billing,description,features,is_popular,badge_text,badge_color,button_text,button_style,button_color,register_plan,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (id) DO NOTHING`,
      [id,name,price,billing,description,features,is_popular,badge_text,badge_color,button_text,button_style,button_color,register_plan,sort_order]
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
  for (const [id,question,answer,category,sort_order] of faqs) {
    await pool.query(
      'INSERT INTO faqs (id,question,answer,category,sort_order) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING',
      [id,question,answer,category,sort_order]
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
  for (const [id,name,role,bio,team_type,linkedin_url,twitter_url,other_social_icon,other_social_url,sort_order] of team) {
    await pool.query(
      `INSERT INTO team_members (id,name,role,bio,team_type,linkedin_url,twitter_url,other_social_icon,other_social_url,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [id,name,role,bio,team_type,linkedin_url,twitter_url,other_social_icon,other_social_url,sort_order]
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
  for (const [id,title,category,description,icon,s1v,s1l,s2v,s2l,s3v,s3l,sort_order] of portfolio) {
    await pool.query(
      `INSERT INTO portfolio_items (id,title,category,description,icon,stat1_value,stat1_label,stat2_value,stat2_label,stat3_value,stat3_label,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
      [id,title,category,description,icon,s1v,s1l,s2v,s2l,s3v,s3l,sort_order]
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
  for (const [id,title,category,description,icon,s1v,s1l,s2v,s2l,s3v,s3l,sort_order] of cases) {
    await pool.query(
      `INSERT INTO case_studies (id,title,category,description,icon,stat1_value,stat1_label,stat2_value,stat2_label,stat3_value,stat3_label,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
      [id,title,category,description,icon,s1v,s1l,s2v,s2l,s3v,s3l,sort_order]
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
  for (const [id,title,description,level,duration_hours,students,icon,gradient,level_color,sort_order] of courses) {
    await pool.query(
      `INSERT INTO courses (id,title,description,level,duration_hours,students,icon,gradient,level_color,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [id,title,description,level,duration_hours,students,icon,gradient,level_color,sort_order]
    );
  }

  // Reset sequences so next auto-generated IDs don't clash with seeded ones
  const seqResets = [
    ['pricing_plans', 4], ['faqs', 7], ['team_members', 8],
    ['portfolio_items', 6], ['case_studies', 6], ['courses', 6],
  ];
  for (const [table, max] of seqResets) {
    await pool.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), $1, true)`, [max]);
  }
}

// ── Public init function called by server.js ──────────────────────────────────
async function init() {
  await createTables();
  await seedAdmin();
  await seedSettings();
  await seedCms();
}

module.exports = { pool, init };
