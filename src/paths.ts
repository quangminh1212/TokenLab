/**
 * Centralized Path Constants
 * Tập trung tất cả đường dẫn dùng chung trong dự án
 */

import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== Base Paths ====================
export const PROJECT_ROOT = path.join(__dirname, '..');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');

// ==================== Data Files ====================
export const MODELS_FILE = path.join(DATA_DIR, 'models.json');
export const PRICING_FILE = path.join(DATA_DIR, 'pricing.json');
export const ENCODINGS_FILE = path.join(DATA_DIR, 'encodings.json');
export const USAGE_FILE = path.join(DATA_DIR, 'usage_history.json');
