-- Up Migration

CREATE TABLE catalog_products (
    id VARCHAR(120) PRIMARY KEY,
    brand VARCHAR(120) NOT NULL,
    name VARCHAR(200) NOT NULL,
    category_id VARCHAR(80) NOT NULL,
    category_name VARCHAR(120) NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    suggested_price VARCHAR(120),
    image_url TEXT,
    source_url TEXT,
    specifications JSONB NOT NULL DEFAULT '{}'::jsonb,
    display_order INTEGER NOT NULL DEFAULT 0,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX catalog_products_enabled_order_idx
  ON catalog_products (enabled, display_order, id);

INSERT INTO catalog_products
  (id, brand, name, category_id, category_name, summary, description, suggested_price, image_url, source_url, specifications, display_order)
VALUES
  ('midea-hft20zbj', 'Midea', '美的塔式暖风机 HFT20ZBJ', 'heating', '取暖',
   '面向小空间的塔式取暖器，强调快速升温与基础安全保护。',
   '塔式机身适合卧室、书房等有限面积空间，广角送风让暖意更均匀。',
   '参考 ¥343',
   'https://oss-accelerate-ga.midea.com/vision-material-634-public-prd-g5-cdn/material_gpim/20260426/0f6e75e87b8ef78d58846cc2ebc49f85.jpg',
   'https://www.midea.cn/27/1000000000400702883665.html',
   '{"额定功率":"2000 W","适用面积":"10㎡以下","档位":"3 档","控制方式":"遥控"}', 1),
  ('xiaomi-electric-warmer', 'Xiaomi', '米家电暖器', 'heating', '取暖',
   '对流式电暖器，适合卧室和书房等有限面积空间。',
   '通过空气微循环对流加热，减少风感，适合需要安静取暖的家庭空间。',
   '以官方渠道为准',
   'https://c1.mifile.cn/f/i/16/chain/warmer-electric/specs-1.jpg',
   'https://www.mi.com/warmer-electric/specs',
   '{"额定功率":"1500 W","适用面积":"15㎡以内","控制方式":"机械 + 触摸 + App","防护等级":"IPX4"}', 2),
  ('xiaomi-air-purifier-pro', 'Xiaomi', '米家空气净化器 Pro', 'air', '空气',
   '以空气循环、传感器和 App 控制为重点的家用空气净化设备。',
   '适用于客厅、卧室等家庭场景，以较高的颗粒物 CADR 帮助改善室内空气循环。',
   '以官方渠道为准',
   'https://c1.mifile.cn/f/i/16/chain/airpro/airpro-02.jpg',
   'https://www.mi.com/airpro',
   '{"颗粒物 CADR":"500 m³/h","适用面积":"35–60㎡","显示":"OLED","控制":"米家 App"}', 3),
  ('xiaomi-fresh-air-ventilator', 'Xiaomi', '米家新风机', 'air', '空气',
   '面向全屋通风的壁挂式设备，提供新风、过滤与辅助升温能力。',
   '壁挂式设计适合需要持续通风的居住空间，资料中提供了风量、功率和噪声等核心参数。',
   '以官方渠道为准',
   'https://i1.mifile.cn/f/i/16/chain/fresh-air-ventilator/specs-01.jpg',
   'https://www.mi.com/fresh-air-ventilator/specs',
   '{"额定风量":"300 m³/h","适用面积":"≤105㎡","额定功率":"42 W","辅热功率":"800 W"}', 4);

-- Down Migration

DROP INDEX catalog_products_enabled_order_idx;
DROP TABLE catalog_products;
