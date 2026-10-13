"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const DATABASE_FILE = path.join(__dirname, "school_system.db");
const COOKIE_NAME = "school_session";
const BRANCH_COOKIE = "school_branch";
const DEFAULT_BRANCH_ID = "main";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ROLES = ["administrator", "branch_admin", "teacher", "accountant", "student", "shopkeeper"];
const GOOGLE_SHEETS_MODULES = {
    students: { title: "Students & Admissions", keys: ["students"] },
    admissions: { title: "Admissions", keys: ["school_admissions"] },
    attendance: { title: "Attendance Records", keys: [] },
    timetable: { title: "Timetable & Schedules", keys: [] },
    fees: { title: "Fees & Financial Ledger", keys: [] },
    gradebook_obe: { title: "Exams, Gradebook & OBE", keys: [] },
    paper_datesheets: { title: "Paper Builder & Datesheets", keys: [] },
    staff: { title: "Staff & Faculty", keys: ["staff"] },
    parents: { title: "Parents Portal", keys: ["school_parents"] },
    events_notices: { title: "Events & Notices", keys: ["school_notices", "school_events", "schoolNotice"] },
    branches: { title: "Branches", keys: [] }
};
const app = express();
const db = new Database(DATABASE_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
    CREATE TABLE IF NOT EXISTS branches (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT NOT NULL UNIQUE COLLATE NOCASE,
        address TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
`);
db.prepare("INSERT OR IGNORE INTO branches (id, name, code) VALUES (?, ?, ?)")
    .run(DEFAULT_BRANCH_ID, "Main Campus", "MAIN");
db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
        key TEXT NOT NULL,
        branch_id TEXT NOT NULL DEFAULT 'main' REFERENCES branches(id),
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (key, branch_id)
    );
    CREATE TABLE IF NOT EXISTS students (
        id TEXT NOT NULL,
        branch_id TEXT NOT NULL DEFAULT 'main' REFERENCES branches(id),
        roll_no TEXT,
        name TEXT NOT NULL,
        class TEXT,
        section TEXT,
        data_json TEXT NOT NULL,
        PRIMARY KEY (id, branch_id)
    );
    CREATE TABLE IF NOT EXISTS gradebook (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL DEFAULT 'main' REFERENCES branches(id),
        class TEXT,
        section TEXT,
        term TEXT,
        subject TEXT,
        student_id TEXT,
        marks_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fees (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL DEFAULT 'main' REFERENCES branches(id),
        student_id TEXT,
        amount REAL,
        status TEXT,
        data_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attendance (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL DEFAULT 'main' REFERENCES branches(id),
        student_id TEXT,
        date TEXT,
        status TEXT,
        data_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS roles (
        name TEXT PRIMARY KEY,
        permissions_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        role TEXT NOT NULL REFERENCES roles(name),
        password_hash TEXT NOT NULL,
        branch_id TEXT NOT NULL DEFAULT 'main' REFERENCES branches(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS staff (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL DEFAULT 'main' REFERENCES branches(id),
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        data_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS datesheets (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL DEFAULT 'main' REFERENCES branches(id),
        class TEXT NOT NULL,
        section TEXT NOT NULL DEFAULT '',
        exam_term TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (branch_id, class, section, exam_term)
    );
    CREATE TABLE IF NOT EXISTS google_sheets_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        spreadsheet_id TEXT NOT NULL DEFAULT '',
        auto_sync_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS google_sheets_sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module_name TEXT NOT NULL,
        branch_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        rows_synced INTEGER NOT NULL DEFAULT 0,
        error_message TEXT NOT NULL DEFAULT '',
        completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS role_pins (
        role TEXT PRIMARY KEY REFERENCES roles(name),
        pin_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_app_state_branch_key ON app_state(branch_id, key);
    CREATE INDEX IF NOT EXISTS idx_students_branch_class_section ON students(branch_id, class, section);
    CREATE INDEX IF NOT EXISTS idx_gradebook_branch_class_section_term ON gradebook(branch_id, class, section, term);
    CREATE INDEX IF NOT EXISTS idx_fees_branch_student ON fees(branch_id, student_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_branch_date ON attendance(branch_id, date);
    CREATE INDEX IF NOT EXISTS idx_users_branch_role ON users(branch_id, role);
    CREATE INDEX IF NOT EXISTS idx_staff_branch ON staff(branch_id);
`);
db.prepare("INSERT OR IGNORE INTO google_sheets_settings (id) VALUES (1)").run();

function tableColumns(table) {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

function ensureBranchColumn(table) {
    if (!tableColumns(table).has("branch_id")) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN branch_id TEXT REFERENCES branches(id)`);
    }
    db.prepare(`UPDATE ${table} SET branch_id = ? WHERE branch_id IS NULL OR branch_id = ''`).run(DEFAULT_BRANCH_ID);
}

if (!tableColumns("app_state").has("branch_id")) {
    db.exec(`
        ALTER TABLE app_state RENAME TO app_state_legacy;
        CREATE TABLE app_state (
            key TEXT NOT NULL,
            branch_id TEXT NOT NULL DEFAULT 'main' REFERENCES branches(id),
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (key, branch_id)
        );
        INSERT INTO app_state (key, branch_id, value, updated_at)
        SELECT key, 'main', value, updated_at FROM app_state_legacy;
        DROP TABLE app_state_legacy;
    `);
}
for (const table of ["students", "gradebook", "fees", "attendance", "users"]) ensureBranchColumn(table);
const studentColumns = db.prepare("PRAGMA table_info(students)").all();
if (studentColumns.find(column => column.name === "id")?.pk === 1
    && studentColumns.find(column => column.name === "branch_id")?.pk !== 2) {
    db.exec(`
        ALTER TABLE students RENAME TO students_legacy;
        CREATE TABLE students (
            id TEXT NOT NULL,
            branch_id TEXT NOT NULL DEFAULT 'main' REFERENCES branches(id),
            roll_no TEXT,
            name TEXT NOT NULL,
            class TEXT,
            section TEXT,
            data_json TEXT NOT NULL,
            PRIMARY KEY (id, branch_id)
        );
        INSERT INTO students (id, branch_id, roll_no, name, class, section, data_json)
        SELECT id, branch_id, roll_no, name, class, section, data_json FROM students_legacy;
        DROP TABLE students_legacy;
    `);
}

const rolePermissions = {
    administrator: ["dashboard", "students", "idCards", "fees", "attendance", "exams", "gradebook", "obeFramework", "paperBuilder", "datesheets", "staff", "schoolStore", "reports", "settings", "admissions", "timetable", "parents", "events"],
    teacher: ["attendance", "timetable", "gradebook", "obeFramework", "paperBuilder", "datesheets", "events"],
    branch_admin: ["dashboard", "students", "idCards", "fees", "attendance", "exams", "gradebook", "obeFramework", "paperBuilder", "datesheets", "staff", "schoolStore", "reports", "admissions", "timetable", "parents", "events"],
    accountant: ["fees", "reports"],
    student: ["dashboard"],
    shopkeeper: ["schoolStore"]
};

const encodeSecret = secret => {
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync(secret, salt, 64);
    return `${salt.toString("hex")}:${derived.toString("hex")}`;
};
const secretMatches = (secret, encoded) => {
    const [saltHex, hashHex] = String(encoded || "").split(":");
    if (!saltHex || !hashHex) return false;
    const actual = crypto.scryptSync(secret, Buffer.from(saltHex, "hex"), 64);
    const expected = Buffer.from(hashHex, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

const insertRole = db.prepare("INSERT OR IGNORE INTO roles (name, permissions_json) VALUES (?, ?)");
for (const role of ROLES) insertRole.run(role, JSON.stringify(rolePermissions[role]));

function ensureSeedAccount(email, name, role, password) {
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (!existing) {
        db.prepare("INSERT INTO users (id, email, name, role, password_hash, branch_id) VALUES (?, ?, ?, ?, ?, ?)")
            .run(crypto.randomUUID(), email, name, role, encodeSecret(password), DEFAULT_BRANCH_ID);
    }
}

ensureSeedAccount("msaadusman091@gmail.com", "School Administrator", "administrator", process.env.ADMIN_INITIAL_PASSWORD || "123456");
const defaultPins = {
    administrator: "Saad1029",
    teacher: "Saad2405",
    accountant: "Saad1322",
    student: "Saad1321",
    shopkeeper: "Saad1321"
};
const insertPin = db.prepare("INSERT OR IGNORE INTO role_pins (role, pin_hash) VALUES (?, ?)");
for (const [role, pin] of Object.entries(defaultPins)) insertPin.run(role, encodeSecret(pin));

const appStateSet = db.prepare(`
    INSERT INTO app_state (key, branch_id, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key, branch_id) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
`);
const safeJson = value => {
    try {
        return JSON.parse(value);
    } catch (error) {
        throw new TypeError(`Invalid JSON state: ${error.message}`);
    }
};

function syncProjection(key, value, branchId = DEFAULT_BRANCH_ID) {
    const records = safeJson(value);
    if (!Array.isArray(records)) return;
    if (key === "students") {
        const replace = db.transaction(items => {
            db.prepare("DELETE FROM students WHERE branch_id = ?").run(branchId);
            db.prepare("DELETE FROM fees WHERE branch_id = ? AND id LIKE ?").run(branchId, `${branchId}:student-%`);
            const add = db.prepare("INSERT INTO students (id, branch_id, roll_no, name, class, section, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
            const addFee = db.prepare("INSERT INTO fees (id, branch_id, student_id, amount, status, data_json) VALUES (?, ?, ?, ?, ?, ?)");
            for (const item of items) {
                if (!item || item.id === undefined || item.id === null || !String(item.name || "").trim()) continue;
                const scopedItem = { ...item, branch_id: branchId };
                add.run(String(item.id), branchId, String(item.roll_no ?? item.rollNo ?? item.id), String(item.name),
                    String(item.class || ""), String(item.section || ""), JSON.stringify(scopedItem));
                const studentId = String(item.id);
                const balance = Number(item.totalPayable ?? item.remainingFees ?? item.fees);
                addFee.run(`${branchId}:student-fees:${studentId}`, branchId, studentId, Number.isFinite(balance) ? balance : null,
                    String(item.status || ""), JSON.stringify({ kind: "student-balance", studentId, balance, status: item.status || "", branch_id: branchId }));
                (Array.isArray(item.paymentHistory) ? item.paymentHistory : []).forEach((payment, index) => {
                    const amount = Number(payment.amountPaid ?? payment.amount);
                    addFee.run(`${branchId}:student-payment:${studentId}:${index}`, branchId, studentId, Number.isFinite(amount) ? amount : null,
                        "Paid", JSON.stringify({ kind: "student-payment", studentId, ...payment, branch_id: branchId }));
                });
            }
        });
        replace(records);
    } else if (key === "examMarks" || key === "gradebook") {
        const replace = db.transaction(items => {
            db.prepare("DELETE FROM gradebook WHERE branch_id = ?").run(branchId);
            const add = db.prepare("INSERT INTO gradebook (id, branch_id, class, section, term, subject, student_id, marks_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
            items.forEach((item, index) => {
                if (!item || typeof item !== "object") return;
                const studentId = String(item.studentId ?? item.student_id ?? "");
                const subject = String(item.subject || "");
                const id = `${branchId}:${String(item.id ?? `${studentId}:${item.term || ""}:${subject}:${index}`)}`;
                const scopedItem = { ...item, branch_id: branchId };
                add.run(id, branchId, String(item.studentClass ?? item.class ?? ""), String(item.studentSection ?? item.section ?? ""),
                    String(item.term ?? item.examTerm ?? ""), subject, studentId, JSON.stringify(scopedItem));
            });
        });
        replace(records);
    } else if (key === "fees" || key === "feeRecords" || key === "fee_records") {
        const replace = db.transaction(items => {
            db.prepare("DELETE FROM fees WHERE branch_id = ? AND id NOT LIKE ?").run(branchId, `${branchId}:student-%`);
            const add = db.prepare("INSERT INTO fees (id, branch_id, student_id, amount, status, data_json) VALUES (?, ?, ?, ?, ?, ?)");
            items.forEach((item, index) => {
                if (!item || typeof item !== "object") return;
                const id = String(item.id ?? `fee-${index}`);
                const amount = Number(item.amount ?? item.amountPaid ?? item.fee);
                add.run(`${branchId}:${id}`, branchId, String(item.studentId ?? item.student_id ?? ""), Number.isFinite(amount) ? amount : null,
                    String(item.status || ""), JSON.stringify({ ...item, branch_id: branchId }));
            });
        });
        replace(records);
    } else if (key.startsWith("att_") || key === "attendance") {
        const replace = db.transaction(items => {
            const date = key.startsWith("att_") ? key.slice(4) : "";
            if (date) db.prepare("DELETE FROM attendance WHERE branch_id = ? AND date = ?").run(branchId, date);
            else db.prepare("DELETE FROM attendance WHERE branch_id = ?").run(branchId);
            const add = db.prepare("INSERT INTO attendance (id, branch_id, student_id, date, status, data_json) VALUES (?, ?, ?, ?, ?, ?)");
            items.forEach((item, index) => {
                if (!item || typeof item !== "object") return;
                const recordDate = String(item.date ?? date);
                const id = String(item.id ?? `${item.studentId ?? "student"}:${recordDate}:${index}`);
                add.run(`${branchId}:${recordDate}:${id}`, branchId, String(item.studentId ?? item.student_id ?? ""), recordDate,
                    String(item.status || ""), JSON.stringify({ ...item, branch_id: branchId }));
            });
        });
        replace(records);
    } else if (key === "staff") {
        const replace = db.transaction(items => {
            db.prepare("DELETE FROM staff WHERE branch_id = ?").run(branchId);
            const add = db.prepare("INSERT INTO staff (id, branch_id, name, role, data_json) VALUES (?, ?, ?, ?, ?)");
            items.forEach((item, index) => {
                if (!item || typeof item !== "object" || !String(item.name || "").trim()) return;
                const id = String(item.id ?? item.staffId ?? `staff-${index}`);
                add.run(`${branchId}:${id}`, branchId, String(item.name), String(item.role || item.designation || ""),
                    JSON.stringify({ ...item, branch_id: branchId }));
            });
        });
        replace(records);
    }
}

function getStateObject(branchId = DEFAULT_BRANCH_ID) {
    return Object.fromEntries(db.prepare("SELECT key, value FROM app_state WHERE branch_id = ?").all(branchId).map(row => [row.key, row.value]));
}

function sessionUser(req) {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return null;
    const record = db.prepare(`
        SELECT users.id, users.email, users.name, users.role, users.branch_id
        FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(crypto.createHash("sha256").update(token).digest("hex"), Date.now());
    return record || null;
}

function requireAuth(req, res, next) {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required." });
    req.user = user;
    next();
}

function requireRoles(...roles) {
    return (req, res, next) => requireAuth(req, res, () => {
        if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Your role is not allowed to access this endpoint." });
        next();
    });
}

function canReadState(role, key) {
    if (role === "administrator" || role === "branch_admin") return true;
    const sharedKeys = new Set(["app_settings", "academySettings", "app_theme", "sidebar_collapsed", "school_logo", "grading_mode", "unread_notifications_count"]);
    if (sharedKeys.has(key)) return true;
    if (role === "teacher") {
        return ["students", "staff", "examMarks", "school_subjects_by_class"].includes(key)
            || key.startsWith("obe_") || key.startsWith("att_") || key.startsWith("staff_att_")
            || key.startsWith("school_timetable") || key.startsWith("school_events")
            || key.startsWith("school_notices") || key.startsWith("school_paper_") || key.startsWith("paper_")
            || key === "read_notification_ids" || key === "unread_notifications_count";
    }
    if (role === "accountant") {
        return ["students", "examMarks"].includes(key) || key.startsWith("fee")
            || key.startsWith("challan") || key.startsWith("att_")
            || key.startsWith("school_fee") || key === "read_notification_ids";
    }
    if (role === "shopkeeper") return key.startsWith("store_") || key === "read_notification_ids";
    return false;
}

function canWriteState(role, key) {
    if (role === "administrator" || role === "branch_admin") return true;
    if (key === "app_theme" || key === "sidebar_collapsed" || key === "read_notification_ids") return true;
    if (role === "teacher") {
        return key === "examMarks" || key === "grading_mode" || key === "school_subjects_by_class"
            || key.startsWith("obe_") || key.startsWith("att_") || key.startsWith("staff_att_")
            || key.startsWith("school_paper_") || key.startsWith("paper_");
    }
    if (role === "accountant") {
        return key === "students" || key.startsWith("fee") || key.startsWith("challan")
            || key.startsWith("school_fee") || key.startsWith("att_");
    }
    if (role === "shopkeeper") return key.startsWith("store_");
    return false;
}

function filterStateValue(role, key, value) {
    if (key === "students" && role === "teacher") {
        return JSON.stringify(safeJson(value).filter(item => item && typeof item === "object").map(item => ({
            id: item.id,
            name: item.name,
            class: item.class,
            section: item.section,
            roll_no: item.roll_no ?? item.rollNo ?? item.id,
            barcode: item.barcode
        })));
    }
    if (key === "app_settings") {
        const settings = safeJson(value);
        delete settings.rolePins;
        if (role === "administrator") return JSON.stringify(settings);
        const allowedFields = role === "teacher"
            ? ["academyName", "tagline", "activeClasses", "sections", "defaultSubjects", "gradingMode", "theme", "idCardTerms"]
            : role === "accountant"
                ? ["academyName", "tagline", "schoolPhone", "schoolAddress", "activeClasses", "sections", "defaultSubjects", "theme", "feeDueDay", "lateFee", "bankTitle", "bankName", "bankAccount"]
                : role === "shopkeeper"
                    ? ["academyName", "tagline", "theme", "posTax"]
                    : ["academyName", "tagline", "theme"];
        return JSON.stringify(Object.fromEntries(allowedFields
            .filter(field => Object.prototype.hasOwnProperty.call(settings, field))
            .map(field => [field, settings[field]])));
    }
    if (key === "academySettings" && role !== "administrator") {
        const settings = safeJson(value);
        const fields = ["academyName", "theme", "tagline", "schoolPhone", "schoolAddress", "schoolWebsite"];
        return JSON.stringify(Object.fromEntries(fields
            .filter(field => Object.prototype.hasOwnProperty.call(settings, field))
            .map(field => [field, settings[field]])));
    }
    return value;
}

function getStateForRole(role, branchId = DEFAULT_BRANCH_ID) {
    return Object.fromEntries(Object.entries(getStateObject(branchId))
        .filter(([key]) => canReadState(role, key))
        .map(([key, value]) => [key, filterStateValue(role, key, value)]));
}

for (const branch of db.prepare("SELECT id FROM branches").all()) {
    const state = getStateObject(branch.id);
    for (const key of ["students", state.examMarks !== undefined ? "examMarks" : "gradebook",
        state.fees !== undefined ? "fees" : state.feeRecords !== undefined ? "feeRecords" : "fee_records", "attendance", "staff"]) {
        if (state[key] !== undefined) syncProjection(key, state[key], branch.id);
    }
    for (const [key, value] of Object.entries(state)) {
        if (key.startsWith("att_")) syncProjection(key, value, branch.id);
    }
}

function requestedBranchId(req) {
    const requested = req.query.branch_id || req.body?.branch_id || req.cookies?.[BRANCH_COOKIE] || DEFAULT_BRANCH_ID;
    const branch = db.prepare("SELECT id FROM branches WHERE id = ?").get(String(requested));
    if (!branch) {
        const error = new Error("The requested branch does not exist.");
        error.status = 400;
        throw error;
    }
    if (req.user && req.user.role !== "administrator" && String(req.user.branch_id || DEFAULT_BRANCH_ID) !== branch.id) {
        const error = new Error("Your account is restricted to its assigned branch.");
        error.status = 403;
        throw error;
    }
    return branch.id;
}

function branchContext(req, res, next) {
    try {
        req.branchId = requestedBranchId(req);
        next();
    } catch (error) {
        res.status(error.status || 400).json({ error: error.message });
    }
}

function branchReadContext(req, res, next) {
    if (req.query.branch_id === "all") {
        if (req.user.role !== "administrator") {
            return res.status(403).json({ error: "Only a centralized administrator can query all branches." });
        }
        req.branchId = null;
        req.allBranches = true;
        return next();
    }
    branchContext(req, res, next);
}

function setBranchCookie(res, branchId) {
    res.append("Set-Cookie", `${BRANCH_COOKIE}=${encodeURIComponent(branchId)}; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`);
}

function branchRecord(req, branchId) {
    return db.prepare("SELECT id, name, code, address, phone, created_at FROM branches WHERE id = ?").get(branchId);
}

function getGoogleSheetsSettings() {
    const saved = db.prepare("SELECT spreadsheet_id, auto_sync_json FROM google_sheets_settings WHERE id = 1").get();
    let autoSync = {};
    try {
        autoSync = JSON.parse(saved?.auto_sync_json || "{}");
    } catch (error) {
        console.error("Google Sheets auto-sync settings are invalid:", error);
    }
    return {
        spreadsheetId: saved?.spreadsheet_id || process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "",
        autoSync: Object.fromEntries(Object.keys(GOOGLE_SHEETS_MODULES).map(moduleName => [
            moduleName,
            autoSync[moduleName] === true
        ]))
    };
}

function googleCredentialsStatus() {
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
        try {
            const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
            return {
                configured: Boolean(credentials.client_email && credentials.private_key),
                source: "environment",
                serviceAccountEmail: credentials.client_email || ""
            };
        } catch {
            return { configured: false, source: "invalid-environment-configuration" };
        }
    }
    const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!keyFile) return { configured: false, source: "not-configured" };
    try {
        const credentials = JSON.parse(fs.readFileSync(path.resolve(keyFile), "utf8"));
        return {
            configured: Boolean(credentials.client_email && credentials.private_key),
            source: "credentials-file",
            serviceAccountEmail: credentials.client_email || ""
        };
    } catch {
        return { configured: false, source: "credentials-file-unavailable" };
    }
}

function configuredGoogleSheetsClient() {
    const { google } = require("googleapis");
    const authOptions = {
        scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    };
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
        try {
            authOptions.credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
        } catch {
            throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.");
        }
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        const keyFile = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
        if (!fs.existsSync(keyFile)) throw new Error("The configured Google credentials file is unavailable.");
        authOptions.keyFile = keyFile;
    } else {
        throw new Error("Configure GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS on the server.");
    }
    return google.sheets({ version: "v4", auth: new google.auth.GoogleAuth(authOptions) });
}

function normalizeSpreadsheetId(value) {
    if (typeof value !== "string") throw new TypeError("Provide a Google Spreadsheet ID or URL.");
    const input = value.trim();
    if (input.length > 500) throw new TypeError("The spreadsheet ID or URL is too long.");
    const urlMatch = input.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
    const spreadsheetId = urlMatch ? urlMatch[1] : input;
    if (!/^[A-Za-z0-9_-]{10,}$/.test(spreadsheetId)) {
        throw new TypeError("Provide a valid Google Spreadsheet ID or full spreadsheet URL.");
    }
    return spreadsheetId;
}

function sanitizeGoogleSheetsValue(value) {
    if (Array.isArray(value)) return value.map(sanitizeGoogleSheetsValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .filter(([key]) => !/(?:password|pin|secret|credential|access.?token|refresh.?token)/i.test(key))
            .map(([key, item]) => [
                key,
                /(?:photo|image|signature|logo)/i.test(key) && typeof item === "string" && item.length > 500
                    ? "[media omitted]"
                    : sanitizeGoogleSheetsValue(item)
            ]));
    }
    if (typeof value === "string" && /^data:image\//i.test(value)) return "[media omitted]";
    return value;
}

function moduleStateKeys(moduleName, state) {
    const explicit = GOOGLE_SHEETS_MODULES[moduleName].keys;
    if (explicit.length) return explicit.filter(key => Object.prototype.hasOwnProperty.call(state, key));
    if (moduleName === "attendance") {
        const datedKeys = Object.keys(state).filter(key => /^att_\d{4}-\d{2}-\d{2}$/.test(key));
        if (datedKeys.length) return [...datedKeys, ...Object.keys(state).filter(key => /^staff_att_/.test(key))];
    }
    const matchers = {
        attendance: key => key === "attendance" || /^att_\d{4}-\d{2}-\d{2}$/.test(key) || /^staff_att_/.test(key),
        timetable: key => /^school_timetable/.test(key),
        fees: key => /^(?:fee|challan)/i.test(key) || /^school_fee/.test(key) || ["store_sales", "store_inventory"].includes(key),
        gradebook_obe: key => ["examMarks", "gradebook", "grading_mode", "grading_rubrics", "school_subjects_by_class"].includes(key) || /^obe_/.test(key),
        paper_datesheets: key => /^school_paper_/.test(key) || /^paper_/.test(key),
        events_notices: key => ["school_notices", "school_events", "schoolNotice"].includes(key)
    };
    return Object.keys(state).filter(key => matchers[moduleName]?.(key));
}

function googleSheetsRows(moduleName, branchIds) {
    const rows = [["Branch ID", "Record Type", "Record ID", "Record JSON"]];
    let recordCount = 0;
    for (const branchId of branchIds) {
        if (moduleName === "branches") {
            const branch = db.prepare("SELECT id, name, code, address, phone, created_at FROM branches WHERE id = ?").get(branchId);
            if (branch) {
                rows.push([branchId, "branch", branch.id, JSON.stringify(sanitizeGoogleSheetsValue(branch))]);
                recordCount++;
            }
            continue;
        }
        if (moduleName === "paper_datesheets") {
            const datesheets = db.prepare("SELECT id, class, section, exam_term, schedule_json, created_at FROM datesheets WHERE branch_id = ? ORDER BY class, section, exam_term").all(branchId);
            for (const datesheet of datesheets) {
                const record = { ...datesheet, schedule: JSON.parse(datesheet.schedule_json) };
                delete record.schedule_json;
                rows.push([branchId, "datesheet", datesheet.id, JSON.stringify(sanitizeGoogleSheetsValue(record))]);
                recordCount++;
            }
        }
        if (moduleName === "fees") {
            const fees = db.prepare("SELECT id, data_json FROM fees WHERE branch_id = ? ORDER BY id").all(branchId);
            for (const fee of fees) {
                const json = JSON.stringify(sanitizeGoogleSheetsValue(JSON.parse(fee.data_json)));
                if (json.length > 45000) {
                    throw new Error(`Financial record ${fee.id} in branch ${branchId} is too large for a Google Sheets cell.`);
                }
                rows.push([branchId, "financial_ledger", fee.id, json]);
                recordCount++;
            }
        }
        const state = getStateObject(branchId);
        for (const key of moduleStateKeys(moduleName, state)) {
            if (moduleName === "fees" && ["fees", "feeRecords", "fee_records"].includes(key)) continue;
            let value;
            try {
                value = JSON.parse(state[key]);
            } catch (error) {
                throw new Error(`Cannot sync ${key} in branch ${branchId}: stored JSON is invalid (${error.message}).`);
            }
            const records = Array.isArray(value) ? value : [value];
            records.forEach((record, index) => {
                const safeRecord = sanitizeGoogleSheetsValue(record);
                const json = JSON.stringify(safeRecord);
                if (json.length > 45000) {
                    throw new Error(`Record ${key}/${index + 1} in branch ${branchId} is too large for a Google Sheets cell.`);
                }
                const recordId = record && typeof record === "object"
                    ? String(record.id ?? record.studentId ?? record.student_id ?? `${key}-${index + 1}`)
                    : `${key}-${index + 1}`;
                rows.push([branchId, key, recordId, json]);
                recordCount++;
            });
        }
    }
    return { rows, recordCount };
}

function recordGoogleSheetsSync(moduleName, branchIds, status, rowsSynced = 0, errorMessage = "") {
    db.prepare(`
        INSERT INTO google_sheets_sync_runs (module_name, branch_id, status, rows_synced, error_message)
        VALUES (?, ?, ?, ?, ?)
    `).run(moduleName, branchIds.join(","), status, rowsSynced, errorMessage.slice(0, 1000));
    db.prepare(`
        DELETE FROM google_sheets_sync_runs
        WHERE id NOT IN (SELECT id FROM google_sheets_sync_runs ORDER BY id DESC LIMIT 500)
    `).run();
}

function googleWorksheetTitle(moduleName, branchIds, aggregate) {
    const baseTitle = GOOGLE_SHEETS_MODULES[moduleName].title;
    if (moduleName === "branches" || aggregate || branchIds.length !== 1) return baseTitle;
    const branch = db.prepare("SELECT code FROM branches WHERE id = ?").get(branchIds[0]);
    return `${baseTitle} - ${branch?.code || branchIds[0]}`.slice(0, 100);
}

async function performGoogleSheetsSync(moduleNames, branchIds, aggregate = false) {
    const settings = getGoogleSheetsSettings();
    if (!settings.spreadsheetId) throw new Error("Set a Google Spreadsheet ID in Settings before syncing.");
    const sheets = configuredGoogleSheetsClient();
    const spreadsheetId = settings.spreadsheetId;
    const response = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: "sheets.properties(sheetId,title)"
    });
    const existingTitles = new Set((response.data.sheets || []).map(sheet => sheet.properties?.title));
    const missingModules = moduleNames.filter(moduleName => !existingTitles.has(GOOGLE_SHEETS_MODULES[moduleName].title));
    if (missingModules.length) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: missingModules.map(moduleName => ({
                    addSheet: { properties: { title: GOOGLE_SHEETS_MODULES[moduleName].title } }
                }))
            }
        });
    }

    const sheetsData = moduleNames.map(moduleName => {
        const moduleBranchIds = moduleName === "branches"
            ? db.prepare("SELECT id FROM branches ORDER BY id").all().map(branch => branch.id)
            : branchIds;
        return {
            moduleName,
            branchIds: moduleBranchIds,
            title: googleWorksheetTitle(moduleName, moduleBranchIds, aggregate),
            ...googleSheetsRows(moduleName, moduleBranchIds)
        };
    });
    await sheets.spreadsheets.values.batchClear({
        spreadsheetId,
        requestBody: { ranges: sheetsData.map(item => `'${item.title.replace(/'/g, "''")}'!A:Z`) }
    });
    for (const item of sheetsData) {
        let chunk = [];
        let chunkBytes = 0;
        let firstRow = 1;
        const writeChunk = async () => {
            if (!chunk.length) return;
            await sheets.spreadsheets.values.batchUpdate({
                spreadsheetId,
                requestBody: {
                    valueInputOption: "RAW",
                    data: [{
                        range: `'${item.title.replace(/'/g, "''")}'!A${firstRow}`,
                        majorDimension: "ROWS",
                        values: chunk
                    }]
                }
            });
            firstRow += chunk.length;
            chunk = [];
            chunkBytes = 0;
        };
        for (const row of item.rows) {
            const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
            if (chunk.length && (chunkBytes + rowBytes > 7_000_000 || chunk.length >= 2000)) await writeChunk();
            chunk.push(row);
            chunkBytes += rowBytes;
        }
        await writeChunk();
    }
    const totalRows = sheetsData.reduce((sum, item) => sum + item.recordCount, 0);
    for (const item of sheetsData) recordGoogleSheetsSync(item.moduleName, item.branchIds, "success", item.recordCount);
    return {
        spreadsheetId,
        modules: sheetsData.map(({ moduleName, title, recordCount }) => ({
            module_name: moduleName,
            worksheet: title,
            rows_synced: recordCount
        })),
        rows_synced: totalRows
    };
}

let googleSheetsSyncQueue = Promise.resolve();
function queueGoogleSheetsSync(moduleNames, branchIds, aggregate = false) {
    const run = googleSheetsSyncQueue.then(() => performGoogleSheetsSync(moduleNames, branchIds, aggregate));
    googleSheetsSyncQueue = run.catch(() => {});
    return run;
}

const pendingGoogleAutoSync = new Map();
function triggerGoogleSheetsAutoSync(moduleName, branchId) {
    if (!GOOGLE_SHEETS_MODULES[moduleName]) return;
    const settings = getGoogleSheetsSettings();
    if (!settings.autoSync[moduleName] || !settings.spreadsheetId || !googleCredentialsStatus().configured) return;
    const timerKey = `${moduleName}:${branchId}`;
    clearTimeout(pendingGoogleAutoSync.get(timerKey));
    pendingGoogleAutoSync.set(timerKey, setTimeout(() => {
        pendingGoogleAutoSync.delete(timerKey);
        const branchIds = moduleName === "branches"
            ? db.prepare("SELECT id FROM branches ORDER BY id").all().map(branch => branch.id)
            : [branchId];
        queueGoogleSheetsSync([moduleName], branchIds, moduleName === "branches").catch(error => {
            recordGoogleSheetsSync(moduleName, [branchId], "error", 0, error.message);
            console.error(`Automatic Google Sheets sync failed for ${moduleName}/${branchId}:`, error);
        });
    }, 500));
}

function modulesForStateKey(key) {
    const result = [];
    for (const moduleName of Object.keys(GOOGLE_SHEETS_MODULES)) {
        if (moduleStateKeys(moduleName, { [key]: "" }).includes(key)) result.push(moduleName);
    }
    if (key === "students" && !result.includes("fees")) result.push("fees");
    return result;
}

app.use(cors({
    origin(origin, callback) {
        const allowedOrigins = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
        if (!origin || allowedOrigins.has(origin)) return callback(null, true);
        return callback(new Error("Cross-origin access is not allowed."));
    },
    credentials: true
}));
app.use(express.json({ limit: "50mb" }));
app.use((req, res, next) => {
    req.cookies = Object.fromEntries(String(req.headers.cookie || "").split(";").filter(Boolean).map(cookie => {
        const splitAt = cookie.indexOf("=");
        return [cookie.slice(0, splitAt).trim(), decodeURIComponent(cookie.slice(splitAt + 1).trim())];
    }));
    next();
});

app.get("/api/health", (_req, res) => res.json({ status: "ok", database: path.basename(DATABASE_FILE) }));

app.get("/api/integrations/google-sheets/status", requireRoles("administrator"), (_req, res) => {
    const settings = getGoogleSheetsSettings();
    const recentRuns = db.prepare(`
        SELECT module_name, branch_id, status, rows_synced, error_message, completed_at
        FROM google_sheets_sync_runs ORDER BY id DESC LIMIT 50
    `).all();
    res.json({
        spreadsheetId: settings.spreadsheetId,
        credentials: googleCredentialsStatus(),
        autoSync: settings.autoSync,
        recentRuns
    });
});

app.put("/api/integrations/google-sheets/settings", requireRoles("administrator"), (req, res) => {
    const { spreadsheet_id: spreadsheetInput, auto_sync: autoSyncInput } = req.body || {};
    if (typeof spreadsheetInput !== "string" || !autoSyncInput || typeof autoSyncInput !== "object" || Array.isArray(autoSyncInput)) {
        return res.status(400).json({ error: "Provide a spreadsheet ID or URL and per-module auto-sync settings." });
    }
    if (Object.entries(autoSyncInput).some(([moduleName, enabled]) =>
        !Object.prototype.hasOwnProperty.call(GOOGLE_SHEETS_MODULES, moduleName) || typeof enabled !== "boolean")) {
        return res.status(400).json({ error: "Auto-sync settings must contain only supported modules with boolean values." });
    }
    let spreadsheetId = "";
    try {
        spreadsheetId = spreadsheetInput.trim() ? normalizeSpreadsheetId(spreadsheetInput) : "";
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
    const autoSync = Object.fromEntries(Object.keys(GOOGLE_SHEETS_MODULES).map(moduleName => [
        moduleName,
        autoSyncInput[moduleName] === true
    ]));
    db.prepare(`
        INSERT INTO google_sheets_settings (id, spreadsheet_id, auto_sync_json, updated_at)
        VALUES (1, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET spreadsheet_id = excluded.spreadsheet_id,
            auto_sync_json = excluded.auto_sync_json, updated_at = CURRENT_TIMESTAMP
    `).run(spreadsheetId, JSON.stringify(autoSync));
    res.json({
        spreadsheetId: spreadsheetId || process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "",
        autoSync,
        credentials: googleCredentialsStatus()
    });
});

app.post("/api/integrations/google-sheets/sync-all", requireRoles("administrator"), async (req, res) => {
    let branchIds;
    try {
        const requested = req.body?.branch_id;
        if (req.user.role === "administrator" && (!requested || requested === "all")) {
            branchIds = db.prepare("SELECT id FROM branches ORDER BY id").all().map(branch => branch.id);
        } else {
            branchIds = [requestedBranchId({ ...req, query: {}, body: { branch_id: requested } })];
        }
        const result = await queueGoogleSheetsSync(Object.keys(GOOGLE_SHEETS_MODULES), branchIds, true);
        res.json({ ...result, branch_ids: branchIds });
    } catch (error) {
        for (const moduleName of Object.keys(GOOGLE_SHEETS_MODULES)) {
            recordGoogleSheetsSync(moduleName, branchIds || [], "error", 0, error.message);
        }
        console.error("Google Sheets full synchronization failed:", error);
        res.status(502).json({ error: error.message || "Google Sheets synchronization failed." });
    }
});

app.post("/api/integrations/google-sheets/sync-module", requireRoles("administrator"), async (req, res) => {
    const { module_name: moduleName, branch_id: requestedBranch } = req.body || {};
    if (typeof moduleName !== "string" || !Object.prototype.hasOwnProperty.call(GOOGLE_SHEETS_MODULES, moduleName)) {
        return res.status(400).json({ error: "Provide a supported module_name." });
    }
    try {
        const branchIds = req.user.role === "administrator" && requestedBranch === "all"
            ? db.prepare("SELECT id FROM branches ORDER BY id").all().map(branch => branch.id)
            : [requestedBranchId({ ...req, query: {}, body: { branch_id: requestedBranch } })];
        const result = await queueGoogleSheetsSync([moduleName], branchIds, requestedBranch === "all" || branchIds.length > 1);
        res.json({ ...result, branch_ids: branchIds });
    } catch (error) {
        recordGoogleSheetsSync(moduleName, [requestedBranch || req.user.branch_id || DEFAULT_BRANCH_ID], "error", 0, error.message);
        console.error(`Google Sheets sync failed for ${moduleName}:`, error);
        res.status(502).json({ error: error.message || "Google Sheets synchronization failed." });
    }
});

app.get("/api/bootstrap.js", (req, res) => {
    const user = sessionUser(req);
    let branchId = user?.role === "administrator"
        ? (req.cookies[BRANCH_COOKIE] || DEFAULT_BRANCH_ID)
        : (user?.branch_id || DEFAULT_BRANCH_ID);
    if (!db.prepare("SELECT 1 FROM branches WHERE id = ?").get(branchId)) branchId = DEFAULT_BRANCH_ID;
    const state = user ? getStateForRole(user.role, branchId) : {};
    if (user) {
        state.isLoggedIn = "true";
        state.active_user_role = user.role;
        state.active_user_name = user.name;
        state.active_branch_id = branchId;
        state.active_branch_name = branchRecord(req, branchId).name;
    }
    const script = `window.__SCHOOL_STATE__=${JSON.stringify(state).replace(/</g, "\\u003c")};`;
    res.type("application/javascript").set("Cache-Control", "no-store").send(script);
});

app.post("/api/auth/login", (req, res) => {
    const { email, password, role, pin } = req.body || {};
    let user;
    if (typeof email === "string" && typeof password === "string") {
        const account = db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase());
        if (account && secretMatches(password, account.password_hash)) user = account;
    } else if (typeof role === "string" && typeof pin === "string" && ROLES.includes(role)) {
        const credentials = db.prepare("SELECT pin_hash FROM role_pins WHERE role = ?").get(role);
        if (credentials && secretMatches(pin, credentials.pin_hash)) {
            user = db.prepare("SELECT * FROM users WHERE role = ? ORDER BY created_at LIMIT 1").get(role);
            if (!user) {
                const id = crypto.randomUUID();
                db.prepare("INSERT INTO users (id, email, name, role, password_hash, branch_id) VALUES (?, ?, ?, ?, ?, ?)")
                    .run(id, `${role}@local.school`, role[0].toUpperCase() + role.slice(1), role, encodeSecret(crypto.randomUUID()), DEFAULT_BRANCH_ID);
                user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
            }
        }
    }
    if (!user) return res.status(401).json({ error: "Invalid email/password or role/PIN." });

    const token = crypto.randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .run(crypto.createHash("sha256").update(token).digest("hex"), user.id, Date.now() + SESSION_MAX_AGE_MS);
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`);
    setBranchCookie(res, user.role === "administrator"
        ? (req.cookies[BRANCH_COOKIE] || DEFAULT_BRANCH_ID)
        : (user.branch_id || DEFAULT_BRANCH_ID));
    res.json({ role: user.role, name: user.name, branch_id: user.branch_id || DEFAULT_BRANCH_ID });
});

app.post("/api/auth/verify-pin", requireAuth, (req, res) => {
    const { pin, role = "administrator" } = req.body || {};
    if (role !== "administrator" || req.user.role !== "administrator" || typeof pin !== "string") {
        return res.status(403).json({ error: "Administrator verification is required." });
    }
    const credentials = db.prepare("SELECT pin_hash FROM role_pins WHERE role = 'administrator'").get();
    if (!credentials || !secretMatches(pin, credentials.pin_hash)) {
        return res.status(401).json({ error: "Invalid administrator PIN." });
    }
    res.json({ valid: true });
});

app.post("/api/auth/pins", requireAuth, (req, res) => {
    if (req.user.role !== "administrator") return res.status(403).json({ error: "Only an administrator can change role PINs." });
    const pins = req.body?.pins;
    if (!pins || typeof pins !== "object" || Array.isArray(pins)
        || Object.entries(pins).some(([role, pin]) => !ROLES.includes(role)
            || typeof pin !== "string" || !/^[A-Za-z0-9]{4,32}$/.test(pin))) {
        return res.status(400).json({ error: "Each PIN update must contain a valid role and a 4–32 character alphanumeric PIN." });
    }
    const update = db.transaction(() => {
        const savePin = db.prepare(`
            INSERT INTO role_pins (role, pin_hash) VALUES (?, ?)
            ON CONFLICT(role) DO UPDATE SET pin_hash = excluded.pin_hash
        `);
        for (const [role, pin] of Object.entries(pins)) savePin.run(role, encodeSecret(pin));
    });
    update();
    res.json({ updated: Object.keys(pins).length });
});

app.post("/api/auth/signup", (req, res) => {
    const { email, name, password } = req.body || {};
    if (typeof email !== "string" || !email.trim() || typeof name !== "string" || !name.trim()
        || typeof password !== "string" || password.length < 6) {
        return res.status(400).json({ error: "Provide a name, valid email, and password of at least six characters." });
    }
    try {
        const id = crypto.randomUUID();
        db.prepare("INSERT INTO users (id, email, name, role, password_hash, branch_id) VALUES (?, ?, ?, 'student', ?, ?)")
            .run(id, email.trim().toLowerCase(), name.trim(), encodeSecret(password), DEFAULT_BRANCH_ID);
        const token = crypto.randomBytes(32).toString("base64url");
        db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
            .run(crypto.createHash("sha256").update(token).digest("hex"), id, Date.now() + SESSION_MAX_AGE_MS);
        res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`);
        setBranchCookie(res, DEFAULT_BRANCH_ID);
        return res.status(201).json({ role: "student", name: name.trim() });
    } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "An account with that email already exists." });
        console.error("Account creation failed:", error);
        return res.status(500).json({ error: "Unable to create the account." });
    }
});

app.post("/api/auth/logout", (req, res) => {
    const token = req.cookies[COOKIE_NAME];
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(crypto.createHash("sha256").update(token).digest("hex"));
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.append("Set-Cookie", `${BRANCH_COOKIE}=; SameSite=Lax; Path=/; Max-Age=0`);
    res.status(204).end();
});

app.get("/api/state", requireAuth, branchContext, (req, res) => {
    res.json({ state: getStateForRole(req.user.role, req.branchId), branch: branchRecord(req, req.branchId) });
});
app.put("/api/state", requireAuth, branchContext, (req, res) => {
    const changes = req.body?.changes;
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
        return res.status(400).json({ error: "State changes must be an object of string values." });
    }
    const entries = Object.entries(changes);
    if (entries.some(([key, value]) => !key || key.length > 200
        || (value !== null && (typeof value !== "string" || value.length > 40_000_000)))) {
        return res.status(400).json({ error: "State keys and values are invalid or too large." });
    }
    if (entries.some(([key]) => ["users", "role_pins", "isLoggedIn", "active_user_role", "active_user_name"].includes(key))) {
        return res.status(400).json({ error: "Authentication and account records must be managed through the authenticated auth API." });
    }
    const forbiddenKey = entries.find(([key]) => !canWriteState(req.user.role, key))?.[0];
    if (forbiddenKey) return res.status(403).json({ error: `Your ${req.user.role} role cannot update "${forbiddenKey}".` });
    try {
        const persist = db.transaction(() => {
            for (const [key, value] of entries) {
                if (value === null) {
                    db.prepare("DELETE FROM app_state WHERE key = ? AND branch_id = ?").run(key, req.branchId);
                    if (["students", "examMarks", "gradebook", "fees", "feeRecords", "fee_records", "attendance"].includes(key)
                        || key.startsWith("att_") || key === "staff") syncProjection(key, "[]", req.branchId);
                    continue;
                }
                let stateValue = value;
                if (key === "app_settings") {
                    const settings = safeJson(value);
                    delete settings.rolePins;
                    stateValue = JSON.stringify(settings);
                }
                appStateSet.run(key, req.branchId, stateValue);
                if (["students", "examMarks", "gradebook", "fees", "feeRecords", "fee_records", "attendance"].includes(key)
                    || key.startsWith("att_") || key === "staff") syncProjection(key, stateValue, req.branchId);
            }
        });
        persist();
        const modules = new Set(entries.flatMap(([key]) => modulesForStateKey(key)));
        for (const moduleName of modules) triggerGoogleSheetsAutoSync(moduleName, req.branchId);
        return res.json({ saved: entries.length });
    } catch (error) {
        console.error("State persistence failed:", error);
        return res.status(400).json({ error: `State was not saved: ${error.message}` });
    }
});
app.delete("/api/state/:key", requireAuth, branchContext, (req, res) => {
    if (!canWriteState(req.user.role, req.params.key)) {
        return res.status(403).json({ error: `Your ${req.user.role} role cannot delete "${req.params.key}".` });
    }
    if (["students", "examMarks", "gradebook", "fees", "feeRecords", "fee_records", "attendance"].includes(req.params.key)
        || req.params.key.startsWith("att_") || req.params.key === "staff") {
        syncProjection(req.params.key, "[]", req.branchId);
    }
    const result = db.prepare("DELETE FROM app_state WHERE key = ? AND branch_id = ?").run(req.params.key, req.branchId);
    if (result.changes) {
        for (const moduleName of modulesForStateKey(req.params.key)) triggerGoogleSheetsAutoSync(moduleName, req.branchId);
    }
    res.status(result.changes ? 204 : 404).end();
});
app.delete("/api/state", requireRoles("administrator"), (_req, res) => {
    const branchIds = db.prepare("SELECT id FROM branches").all().map(branch => branch.id);
    db.transaction(() => {
        db.prepare("DELETE FROM app_state").run();
        db.prepare("DELETE FROM students").run();
        db.prepare("DELETE FROM gradebook").run();
        db.prepare("DELETE FROM fees").run();
        db.prepare("DELETE FROM attendance").run();
        db.prepare("DELETE FROM staff").run();
        db.prepare("DELETE FROM datesheets").run();
    })();
    for (const branchId of branchIds) {
        for (const moduleName of Object.keys(GOOGLE_SHEETS_MODULES)) triggerGoogleSheetsAutoSync(moduleName, branchId);
    }
    res.status(204).end();
});

app.get("/api/branches", requireAuth, branchContext, (req, res) => {
    const branches = req.user.role === "administrator"
        ? db.prepare("SELECT id, name, code, address, phone, created_at FROM branches ORDER BY name").all()
        : [branchRecord(req, req.branchId)];
    res.json(branches);
});
app.post("/api/branches/active", requireAuth, branchContext, (req, res) => {
    setBranchCookie(res, req.branchId);
    res.json({ branch: branchRecord(req, req.branchId) });
});
app.get("/api/branches/overview", requireRoles("administrator"), (_req, res) => {
    const overview = db.prepare(`
        SELECT b.id, b.name, b.code,
            (SELECT COUNT(*) FROM students s WHERE s.branch_id = b.id) AS students,
            (SELECT COUNT(*) FROM gradebook g WHERE g.branch_id = b.id) AS assessments,
            (SELECT COUNT(*) FROM attendance a WHERE a.branch_id = b.id) AS attendance_records,
            (SELECT COALESCE(SUM(f.amount), 0) FROM fees f
                WHERE f.branch_id = b.id AND json_extract(f.data_json, '$.kind') IS NULL) AS fees_total,
            (SELECT COALESCE(SUM(f.amount), 0) FROM fees f
                WHERE f.branch_id = b.id AND json_extract(f.data_json, '$.status') = 'Paid') AS fees_collected
        FROM branches b ORDER BY b.name
    `).all();
    res.json(overview);
});
app.post("/api/branches", requireRoles("administrator"), (req, res) => {
    const { name, code, address = "", phone = "" } = req.body || {};
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120
        || typeof code !== "string" || !/^[A-Za-z0-9-]{2,12}$/.test(code.trim())
        || typeof address !== "string" || address.length > 300
        || typeof phone !== "string" || phone.length > 40) {
        return res.status(400).json({ error: "Provide a branch name, a 2–12 character alphanumeric code, and valid address/phone values." });
    }
    const id = crypto.randomUUID();
    try {
        db.prepare("INSERT INTO branches (id, name, code, address, phone) VALUES (?, ?, ?, ?, ?)")
            .run(id, name.trim(), code.trim().toUpperCase(), address.trim(), phone.trim());
        triggerGoogleSheetsAutoSync("branches", id);
        res.status(201).json(branchRecord(req, id));
    } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "That branch code is already in use." });
        console.error("Branch creation failed:", error);
        res.status(500).json({ error: "Unable to create the branch." });
    }
});
app.put("/api/branches/:id", requireRoles("administrator"), (req, res) => {
    const { name, code, address = "", phone = "" } = req.body || {};
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120
        || typeof code !== "string" || !/^[A-Za-z0-9-]{2,12}$/.test(code.trim())
        || typeof address !== "string" || address.length > 300
        || typeof phone !== "string" || phone.length > 40) {
        return res.status(400).json({ error: "Provide a branch name, a 2–12 character alphanumeric code, and valid address/phone values." });
    }
    try {
        const result = db.prepare("UPDATE branches SET name = ?, code = ?, address = ?, phone = ? WHERE id = ?")
            .run(name.trim(), code.trim().toUpperCase(), address.trim(), phone.trim(), req.params.id);
        if (!result.changes) return res.status(404).json({ error: "Branch not found." });
        triggerGoogleSheetsAutoSync("branches", req.params.id);
        res.json(branchRecord(req, req.params.id));
    } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "That branch code is already in use." });
        console.error("Branch update failed:", error);
        res.status(500).json({ error: "Unable to update the branch." });
    }
});
app.delete("/api/branches/:id", requireRoles("administrator"), (req, res) => {
    if (req.params.id === DEFAULT_BRANCH_ID) return res.status(400).json({ error: "The Main Campus branch cannot be deleted." });
    const used = ["users", "students", "gradebook", "fees", "attendance", "staff", "datesheets", "app_state"]
        .some(table => db.prepare(`SELECT 1 FROM ${table} WHERE branch_id = ? LIMIT 1`).get(req.params.id));
    if (used) return res.status(409).json({ error: "This branch still has assigned users or school records. Move or remove them before deleting the branch." });
    const result = db.prepare("DELETE FROM branches WHERE id = ?").run(req.params.id);
    if (result.changes) {
        const remainingBranch = db.prepare("SELECT id FROM branches ORDER BY id LIMIT 1").get();
        if (remainingBranch) triggerGoogleSheetsAutoSync("branches", remainingBranch.id);
    }
    res.status(result.changes ? 204 : 404).end();
});
app.get("/api/users", requireRoles("administrator"), (_req, res) => {
    res.json(db.prepare("SELECT id, email, name, role, branch_id, created_at FROM users ORDER BY name").all());
});
app.post("/api/users", requireRoles("administrator"), (req, res) => {
    const { email, name, role, password, branch_id: branchId = DEFAULT_BRANCH_ID } = req.body || {};
    if (typeof email !== "string" || !email.trim() || typeof name !== "string" || !name.trim()
        || !ROLES.includes(role) || role === "administrator" || typeof password !== "string" || password.length < 6
        || !db.prepare("SELECT 1 FROM branches WHERE id = ?").get(String(branchId))) {
        return res.status(400).json({ error: "Provide a valid name, email, non-administrator role, password of at least six characters, and existing branch." });
    }
    try {
        const id = crypto.randomUUID();
        db.prepare("INSERT INTO users (id, email, name, role, password_hash, branch_id) VALUES (?, ?, ?, ?, ?, ?)")
            .run(id, email.trim().toLowerCase(), name.trim(), role, encodeSecret(password), branchId);
        res.status(201).json(db.prepare("SELECT id, email, name, role, branch_id, created_at FROM users WHERE id = ?").get(id));
    } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "An account with that email already exists." });
        console.error("Branch user creation failed:", error);
        res.status(500).json({ error: "Unable to create the branch user." });
    }
});
app.put("/api/users/:id", requireRoles("administrator"), (req, res) => {
    const { name, role, branch_id: branchId } = req.body || {};
    if (typeof name !== "string" || !name.trim() || !ROLES.includes(role) || role === "administrator"
        || !db.prepare("SELECT 1 FROM branches WHERE id = ?").get(String(branchId))) {
        return res.status(400).json({ error: "Provide a valid name, non-administrator role, and existing branch." });
    }
    const result = db.prepare("UPDATE users SET name = ?, role = ?, branch_id = ? WHERE id = ? AND role <> 'administrator'")
        .run(name.trim(), role, branchId, req.params.id);
    if (!result.changes) return res.status(404).json({ error: "Branch user not found." });
    res.json(db.prepare("SELECT id, email, name, role, branch_id, created_at FROM users WHERE id = ?").get(req.params.id));
});

app.get("/api/datesheets", requireRoles("administrator", "branch_admin", "teacher"), branchContext, (req, res) => {
    const { class: className, section, exam_term: examTerm } = req.query;
    const clauses = ["branch_id = ?"];
    const values = [req.branchId];
    if (className !== undefined) { clauses.push("class = ?"); values.push(String(className)); }
    if (section !== undefined) { clauses.push("section = ?"); values.push(String(section)); }
    if (examTerm !== undefined) { clauses.push("exam_term = ?"); values.push(String(examTerm)); }
    const rows = db.prepare(`SELECT id, branch_id, class, section, exam_term, schedule_json, created_at FROM datesheets WHERE ${clauses.join(" AND ")} ORDER BY class, section, exam_term`).all(...values);
    res.json(rows.map(row => ({
        id: row.id,
        branch_id: row.branch_id,
        class: row.class,
        section: row.section,
        exam_term: row.exam_term,
        schedule: JSON.parse(row.schedule_json),
        created_at: row.created_at
    })));
});
app.post("/api/datesheets", requireRoles("administrator", "branch_admin", "teacher"), branchContext, (req, res) => {
    const { id, class: className, section = "", exam_term: examTerm, schedule } = req.body || {};
    const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
        && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    const validTime = value => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (typeof className !== "string" || !className.trim() || className.length > 80
        || typeof section !== "string" || section.length > 40
        || typeof examTerm !== "string" || !examTerm.trim() || examTerm.length > 100
        || !Array.isArray(schedule) || schedule.length === 0 || schedule.length > 100
        || schedule.some(item => !item || typeof item !== "object" || Array.isArray(item) || !validDate(item.date)
            || !validTime(item.time)
            || (item.reportingTime !== undefined && !validTime(item.reportingTime))
            || (item.reporting_time !== undefined && !validTime(item.reporting_time))
            || typeof item.subject !== "string" || !item.subject.trim() || item.subject.length > 120)) {
        return res.status(400).json({ error: "Provide a class, exam term, and 1–100 schedule rows with valid dates, reporting/start times, and subjects." });
    }
    try {
        const recordId = typeof id === "string" && id.trim() ? id.trim() : crypto.randomUUID();
        const normalizedSchedule = schedule.map(item => ({
            ...item,
            reportingTime: item.reportingTime || item.reporting_time || "08:10"
        }));
        db.prepare(`
            INSERT INTO datesheets (id, branch_id, class, section, exam_term, schedule_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(branch_id, class, section, exam_term)
            DO UPDATE SET schedule_json = excluded.schedule_json, created_at = CURRENT_TIMESTAMP
        `).run(recordId, req.branchId, className.trim(), section.trim(), examTerm.trim(), JSON.stringify(normalizedSchedule));
        const saved = db.prepare("SELECT id, branch_id, class, section, exam_term, schedule_json, created_at FROM datesheets WHERE branch_id = ? AND class = ? AND section = ? AND exam_term = ?")
            .get(req.branchId, className.trim(), section.trim(), examTerm.trim());
        res.status(201).json({
            id: saved.id,
            branch_id: saved.branch_id,
            class: saved.class,
            section: saved.section,
            exam_term: saved.exam_term,
            schedule: JSON.parse(saved.schedule_json),
            created_at: saved.created_at
        });
        triggerGoogleSheetsAutoSync("paper_datesheets", req.branchId);
    } catch (error) {
        console.error("Datesheet save failed:", error);
        res.status(500).json({ error: "Unable to save the datesheet." });
    }
});

app.get("/api/students", requireRoles("administrator", "branch_admin", "teacher", "accountant"), branchReadContext, (req, res) => {
    const rows = req.allBranches
        ? db.prepare("SELECT data_json FROM students ORDER BY branch_id, class, section, roll_no").all()
        : db.prepare("SELECT data_json FROM students WHERE branch_id = ? ORDER BY class, section, roll_no").all(req.branchId);
    const records = rows.map(row => JSON.parse(row.data_json));
    res.json(req.user.role === "teacher" ? records.map(item => ({
        id: item.id,
        name: item.name,
        class: item.class,
        section: item.section,
        roll_no: item.roll_no ?? item.rollNo ?? item.id,
        barcode: item.barcode
    })) : records);
});
app.post("/api/students", requireRoles("administrator", "branch_admin", "accountant"), branchContext, (req, res) => {
    const records = Array.isArray(req.body) ? req.body : [req.body];
    if (records.some(item => !item || item.id === undefined || !String(item.name || "").trim())) {
        return res.status(400).json({ error: "Each student requires an id and name." });
    }
    try {
        const save = db.transaction(items => {
            const add = db.prepare(`
                INSERT INTO students (id, branch_id, roll_no, name, class, section, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id, branch_id) DO UPDATE SET roll_no=excluded.roll_no, name=excluded.name, class=excluded.class, section=excluded.section, data_json=excluded.data_json
            `);
            for (const item of items) {
                const scopedItem = { ...item, branch_id: req.branchId };
                add.run(String(item.id), req.branchId, String(item.roll_no ?? item.rollNo ?? item.id), String(item.name),
                    String(item.class || ""), String(item.section || ""), JSON.stringify(scopedItem));
            }
            const current = db.prepare("SELECT data_json FROM students WHERE branch_id = ? ORDER BY class, section, roll_no").all(req.branchId).map(row => JSON.parse(row.data_json));
            appStateSet.run("students", req.branchId, JSON.stringify(current));
            syncProjection("students", JSON.stringify(current), req.branchId);
        });
        save(records);
        triggerGoogleSheetsAutoSync("students", req.branchId);
        triggerGoogleSheetsAutoSync("fees", req.branchId);
        res.status(201).json({ saved: records.length });
    } catch (error) {
        console.error("Student save failed:", error);
        res.status(500).json({ error: "Unable to save students." });
    }
});
app.delete("/api/students/:id", requireRoles("administrator", "branch_admin"), branchContext, (req, res) => {
    const result = db.prepare("DELETE FROM students WHERE id = ? AND branch_id = ?").run(req.params.id, req.branchId);
    const current = db.prepare("SELECT data_json FROM students WHERE branch_id = ? ORDER BY class, section, roll_no").all(req.branchId).map(row => JSON.parse(row.data_json));
    appStateSet.run("students", req.branchId, JSON.stringify(current));
    if (result.changes) {
        triggerGoogleSheetsAutoSync("students", req.branchId);
        triggerGoogleSheetsAutoSync("fees", req.branchId);
    }
    res.status(result.changes ? 204 : 404).end();
});

app.get("/api/gradebook", requireRoles("administrator", "branch_admin", "teacher", "accountant"), branchReadContext, (req, res) => {
    const { class: className, section, term } = req.query;
    const clauses = req.allBranches ? [] : ["branch_id = ?"];
    const values = req.allBranches ? [] : [req.branchId];
    if (className) { clauses.push("class = ?"); values.push(className); }
    if (section) { clauses.push("section = ?"); values.push(section); }
    if (term) { clauses.push("term = ?"); values.push(term); }
    const sql = `SELECT marks_json FROM gradebook${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY class, section, subject, student_id`;
    res.json(db.prepare(sql).all(...values).map(row => JSON.parse(row.marks_json)));
});
app.post("/api/gradebook", requireRoles("administrator", "branch_admin", "teacher"), branchContext, (req, res) => {
    const records = Array.isArray(req.body) ? req.body : [req.body];
    if (records.some(item => !item || item.studentId === undefined || !item.subject || !item.term)) {
        return res.status(400).json({ error: "Each gradebook record requires studentId, subject, and term." });
    }
    try {
        const current = db.prepare("SELECT marks_json FROM gradebook WHERE branch_id = ?").all(req.branchId).map(row => JSON.parse(row.marks_json));
        const incomingIds = new Set(records.map(item => String(item.id || `${item.studentId}:${item.term}:${item.subject}`)));
        const scopedRecords = records.map(item => ({ ...item, branch_id: req.branchId }));
        const next = current.filter(item => !incomingIds.has(String(item.id || `${item.studentId}:${item.term}:${item.subject}`))).concat(scopedRecords);
        const save = db.transaction(() => {
            syncProjection("examMarks", JSON.stringify(next), req.branchId);
            appStateSet.run("examMarks", req.branchId, JSON.stringify(next));
        });
        save();
        triggerGoogleSheetsAutoSync("gradebook_obe", req.branchId);
        res.status(201).json({ saved: records.length });
    } catch (error) {
        console.error("Gradebook save failed:", error);
        res.status(500).json({ error: "Unable to save gradebook records." });
    }
});

app.get("/api/fees", requireRoles("administrator", "branch_admin", "accountant"), branchReadContext, (req, res) => {
    const rows = req.allBranches
        ? db.prepare("SELECT data_json FROM fees ORDER BY branch_id, id").all()
        : db.prepare("SELECT data_json FROM fees WHERE branch_id = ? ORDER BY id").all(req.branchId);
    res.json(rows.map(row => JSON.parse(row.data_json)));
});
app.post("/api/fees", requireRoles("administrator", "branch_admin", "accountant"), branchContext, (req, res) => {
    const records = Array.isArray(req.body) ? req.body : [req.body];
    if (records.some(item => !item || item.id === undefined)) return res.status(400).json({ error: "Each fee record requires an id." });
    try {
        const next = db.prepare("SELECT data_json FROM fees WHERE branch_id = ?").all(req.branchId).map(row => JSON.parse(row.data_json))
            .filter(item => !records.some(record => String(record.id) === String(item.id))).concat(records);
        const scopedRecords = next.map(item => ({ ...item, branch_id: req.branchId }));
        appStateSet.run("fees", req.branchId, JSON.stringify(scopedRecords));
        syncProjection("fees", JSON.stringify(scopedRecords), req.branchId);
        triggerGoogleSheetsAutoSync("fees", req.branchId);
        res.status(201).json({ saved: records.length });
    } catch (error) {
        console.error("Fee save failed:", error);
        res.status(500).json({ error: "Unable to save fee records." });
    }
});
app.get("/api/attendance", requireRoles("administrator", "branch_admin", "teacher", "accountant"), branchReadContext, (req, res) => {
    const rows = req.allBranches
        ? db.prepare("SELECT data_json FROM attendance ORDER BY branch_id, date, student_id").all()
        : db.prepare("SELECT data_json FROM attendance WHERE branch_id = ? ORDER BY date, student_id").all(req.branchId);
    res.json(rows.map(row => JSON.parse(row.data_json)));
});
app.post("/api/attendance", requireRoles("administrator", "branch_admin", "teacher", "accountant"), branchContext, (req, res) => {
    const records = Array.isArray(req.body) ? req.body : [req.body];
    if (records.some(item => !item || (item.studentId === undefined && item.student_id === undefined) || !item.date)) {
        return res.status(400).json({ error: "Each attendance record requires a studentId and date." });
    }
    try {
        const current = db.prepare("SELECT data_json FROM attendance WHERE branch_id = ?").all(req.branchId).map(row => JSON.parse(row.data_json));
        const next = current.filter(item => !records.some(record => String(record.studentId ?? record.student_id) === String(item.studentId ?? item.student_id)
            && String(record.date) === String(item.date))).concat(records);
        const scopedRecords = next.map(item => ({ ...item, branch_id: req.branchId }));
        appStateSet.run("attendance", req.branchId, JSON.stringify(scopedRecords));
        syncProjection("attendance", JSON.stringify(scopedRecords), req.branchId);
        triggerGoogleSheetsAutoSync("attendance", req.branchId);
        res.status(201).json({ saved: records.length });
    } catch (error) {
        console.error("Attendance save failed:", error);
        res.status(500).json({ error: "Unable to save attendance records." });
    }
});

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/index.html", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use((error, _req, res, _next) => {
    console.error("Request failed:", error);
    res.status(500).json({ error: "The server could not complete the request." });
});

app.listen(PORT, HOST, () => {
    console.log(`School Management System available at http://${HOST}:${PORT}`);
    console.log(`SQLite database: ${DATABASE_FILE}`);
});
