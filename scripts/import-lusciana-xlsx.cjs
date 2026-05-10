#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const BACKEND_DIR = path.join(ROOT_DIR, "backend");
const EXPORT_SCRIPT = path.join(__dirname, "export-lusciana-workbook.ps1");
const EXPORT_SCRIPT_PY = path.join(__dirname, "export-lusciana-workbook.py");
const DEFAULT_SOURCE = "C:\\Users\\antoi\\Downloads\\Comptabilité Lusciana.xlsx";
const DEFAULT_WORKBOOK_JSON = path.join(BACKEND_DIR, "tmp", "lusciana-workbook.json");
const DEFAULT_PREVIEW_JSON = path.join(BACKEND_DIR, "tmp", "lusciana-import-preview.json");

function parseArgs(argv) {
  const args = {
    source: DEFAULT_SOURCE,
    workbookJson: DEFAULT_WORKBOOK_JSON,
    output: DEFAULT_PREVIEW_JSON,
    write: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") {
      args.source = argv[index + 1];
      index += 1;
    } else if (arg === "--workbook-json") {
      args.workbookJson = argv[index + 1];
      index += 1;
    } else if (arg === "--output") {
      args.output = argv[index + 1];
      index += 1;
    } else if (arg === "--write") {
      args.write = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/import-lusciana-xlsx.cjs [options]",
      "",
      "Options:",
      "  --source <path>         Source XLSX file",
      "  --workbook-json <path>  Intermediate workbook JSON export",
      "  --output <path>         Preview/import JSON output",
      "  --write                 Write agents/commissions into MongoDB",
      "  -h, --help              Show this help",
      "",
    ].join("\n")
  );
}

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function exportWorkbook(args) {
  ensureDirectory(args.workbookJson);
  const attempts = [];

  for (const pythonCommand of ["python3", "python"]) {
    const result = spawnSync(
      pythonCommand,
      [EXPORT_SCRIPT_PY, args.source, args.workbookJson],
      {
        cwd: ROOT_DIR,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 100,
      }
    );

    if (result.status === 0) {
      return;
    }

    attempts.push(`${pythonCommand}: ${result.stderr || result.stdout || "failed"}`);
  }

  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        EXPORT_SCRIPT,
        "-WorkbookPath",
        args.source,
        "-OutputPath",
        args.workbookJson,
      ],
      {
        cwd: ROOT_DIR,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 100,
      }
    );

    if (result.status === 0) {
      return;
    }

    attempts.push(`powershell: ${result.stderr || result.stdout || "failed"}`);
  }

  throw new Error(attempts.join("\n\n") || "Workbook export failed");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function asString(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return String(value);
    }
    return String(value);
  }

  return String(value).trim();
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, "").replace(",", ".");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeText(value) {
  return asString(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugify(value) {
  return normalizeText(value).replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function isNameLike(value) {
  const text = asString(value);
  if (!text) {
    return false;
  }

  if (/^\d+([.,]\d+)?$/.test(text)) {
    return false;
  }

  return /[A-Za-zÀ-ÿ]/.test(text);
}

function dedupeNames(values) {
  const map = new Map();
  for (const value of values) {
    const text = asString(value);
    if (!isNameLike(text)) {
      continue;
    }

    const key = normalizeText(text);
    if (!key || !map.has(key)) {
      map.set(key, text);
    }
  }

  return [...map.values()];
}

function monthSheets(workbook) {
  return (workbook.sheets || []).filter((sheet) => sheet.name !== "Total");
}

function extractNamesFromColumns(sheet, headerRegex, nameOffset) {
  const collected = [];
  const rows = sheet.rows || [];

  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 18); rowIndex += 1) {
    const row = rows[rowIndex] || [];
    for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
      const cell = asString(row[colIndex]);
      if (!cell || !headerRegex.test(normalizeText(cell))) {
        continue;
      }

      for (let nextRow = rowIndex + 1; nextRow < Math.min(rows.length, rowIndex + 16); nextRow += 1) {
        const code = asString((rows[nextRow] || [])[colIndex]);
        const candidate = asString((rows[nextRow] || [])[colIndex + nameOffset]);
        if (!candidate || !code) {
          continue;
        }

        if (/^journal\b/i.test(candidate) || /^mois\b/i.test(candidate)) {
          break;
        }

        if (!/^\d{4,}$/.test(code) || !isNameLike(candidate)) {
          break;
        }

        collected.push(candidate);
      }
    }
  }

  return dedupeNames(collected);
}

function extractAgents(workbook) {
  const clients = new Map();
  const associates = new Map();
  const suppliers = new Map();

  for (const sheet of monthSheets(workbook)) {
    for (const name of extractNamesFromColumns(sheet, /^liste de client/, 1)) {
      clients.set(normalizeText(name), name);
    }
    for (const name of extractNamesFromColumns(sheet, /^liste d associe/, 1)) {
      associates.set(normalizeText(name), name);
    }
    for (const name of extractNamesFromColumns(sheet, /^liste de fournisseur/, 1)) {
      suppliers.set(normalizeText(name), name);
    }
  }

  const now = new Date().toISOString();
  const items = [];

  for (const [key, pseudo] of [...associates.entries()].sort((left, right) => left[1].localeCompare(right[1]))) {
    items.push({
      pseudo,
      category: "builder",
      discord: "",
      paymentMethods: [],
      pf: "",
      commissionRate: 0,
      memberSince: "",
      isCompany: false,
      iban: "",
      country: "",
      address: "",
      companyName: "",
      createdAt: now,
      updatedAt: now,
      legacyImport: {
        source: "Comptabilité Lusciana.xlsx",
        role: "associate",
      },
    });

    if (clients.has(key)) {
      clients.delete(key);
    }
  }

  for (const pseudo of [...clients.values()].sort((a, b) => a.localeCompare(b))) {
    items.push({
      pseudo,
      category: "client",
      discord: "",
      paymentMethods: [],
      pf: "",
      commissionRate: 0,
      memberSince: "",
      isCompany: false,
      iban: "",
      country: "",
      address: "",
      companyName: "",
      createdAt: now,
      updatedAt: now,
      legacyImport: {
        source: "Comptabilité Lusciana.xlsx",
        role: "client",
      },
    });
  }

  return {
    items,
    clients: [...clients.values()],
    associates: [...associates.values()],
    suppliers: [...suppliers.values()],
  };
}

function isGenericContext(text) {
  const normalized = normalizeText(text);
  return (
    normalized === "" ||
    normalized === "banque" ||
    normalized === "prestation de service" ||
    normalized === "perte de change" ||
    normalized === "recu" ||
    normalized === "re u" ||
    normalized === "acompte recu" ||
    normalized === "paiement recu" ||
    normalized === "pourcentage" ||
    normalized === "depense team" ||
    normalized === "total" ||
    normalized.startsWith("journal de ") ||
    normalized.startsWith("mois d") ||
    normalized.startsWith("mois de ")
  );
}

function getContextTexts(sheetRows, rowIndex, colIndex) {
  const values = [];

  for (let currentRow = Math.max(0, rowIndex - 1); currentRow <= Math.min(sheetRows.length - 1, rowIndex + 3); currentRow += 1) {
    const row = sheetRows[currentRow] || [];
    for (let currentCol = Math.max(0, colIndex - 1); currentCol <= Math.min(row.length - 1, colIndex + 1); currentCol += 1) {
      const text = asString(row[currentCol]);
      if (!text || /^\d+([.,]\d+)?$/.test(text) || isGenericContext(text)) {
        continue;
      }
      values.push(text);
    }
  }

  return unique(values);
}

function getAmountNearLabel(row, colIndex) {
  const candidateOffsets = [2, 3, 1, 4];
  for (const offset of candidateOffsets) {
    const number = asNumber(row[colIndex + offset]);
    if (number !== null && number > 0 && number < 100000) {
      return number;
    }
  }
  return 0;
}

function cleanProjectText(value, actorName) {
  let text = normalizeText(value);
  const actor = normalizeText(actorName);

  text = text.replace(actor, " ");
  text = text.replace(/\b(client|acompte client|associe|fournisseur)\b/g, " ");
  text = text.replace(/\b(devis|facture|acompte|paiement|payement|payment|recu|pour|paypal|divise|divisee|divisee|render|banque|prestation|service|perte|change|mois|journal)\b/g, " ");
  text = text.replace(/\s+/g, " ").trim();

  return text;
}

function bestDescription(label, contextTexts) {
  const candidates = contextTexts.filter((text) => {
    if (normalizeText(text) === normalizeText(label)) {
      return false;
    }

    return !/^(Acompte Client|Client|Associ[eé]|Fournisseur)\s*-\s*/i.test(text);
  });
  if (candidates.length === 0) {
    return label;
  }

  const preferred = candidates
    .filter((text) => /(devis|facture|acompte|paiement|payement|paypal|render)/i.test(text))
    .sort((left, right) => right.length - left.length);

  return (preferred[0] || candidates.sort((left, right) => right.length - left.length)[0] || label).trim();
}

function projectKeyForEvent(event) {
  const primary = cleanProjectText(event.description, event.name);
  if (primary) {
    return `${normalizeText(event.name)}::${primary}`;
  }
  return `${normalizeText(event.name)}::${event.month.toLowerCase()}::${event.row}`;
}

function scanEvents(workbook) {
  const clientEvents = [];
  const associateEvents = [];

  for (const sheet of monthSheets(workbook)) {
    const rows = sheet.rows || [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex] || [];
      for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
        const cellText = asString(row[colIndex]);
        if (!cellText) {
          continue;
        }

        const clientMatch = cellText.match(/^(Acompte Client|Client)\s*-\s*(.+)$/i);
        if (clientMatch) {
          const type = /^acompte client/i.test(clientMatch[1]) ? "deposit" : "invoice";
          const name = clientMatch[2].trim();
          const contextTexts = getContextTexts(rows, rowIndex, colIndex);
          const description = bestDescription(cellText, contextTexts);
          clientEvents.push({
            sourceId: `${sheet.name}:${rowIndex + 1}:${colIndex + 1}:client`,
            month: sheet.name,
            row: rowIndex + 1,
            column: colIndex + 1,
            label: cellText,
            name,
            type,
            amount: getAmountNearLabel(row, colIndex),
            description,
            contextTexts,
          });
          continue;
        }

        const associateMatch = cellText.match(/^Associ[eé]\s*-\s*(.+)$/i);
        if (associateMatch) {
          const name = associateMatch[1].trim();
          const contextTexts = getContextTexts(rows, rowIndex, colIndex);
          const description = bestDescription(cellText, contextTexts);
          associateEvents.push({
            sourceId: `${sheet.name}:${rowIndex + 1}:${colIndex + 1}:associate`,
            month: sheet.name,
            row: rowIndex + 1,
            column: colIndex + 1,
            label: cellText,
            name,
            amount: getAmountNearLabel(row, colIndex),
            description,
            contextTexts,
          });
        }
      }
    }
  }

  for (const event of clientEvents) {
    event.projectKey = projectKeyForEvent(event);
  }

  for (const event of associateEvents) {
    event.projectKey = projectKeyForEvent(event);
  }

  return { clientEvents, associateEvents };
}

function tokenSet(value) {
  return new Set(
    cleanProjectText(value, "")
      .split(" ")
      .filter((token) => token && token.length > 2)
  );
}

function intersectionSize(left, right) {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) {
      count += 1;
    }
  }
  return count;
}

function linkAssociateEvents(clientEvents, associateEvents) {
  const clientTokens = new Map();
  for (const event of clientEvents) {
    clientTokens.set(event.sourceId, tokenSet(event.description));
    event.linkedAssociateEvents = [];
  }

  for (const associate of associateEvents) {
    const associateTokens = tokenSet(associate.description);
    let bestClient = null;
    let bestScore = -Infinity;

    for (const client of clientEvents) {
      if (client.month !== associate.month) {
        continue;
      }

      const rowDistance = Math.abs(client.row - associate.row);
      if (rowDistance > 35) {
        continue;
      }

      const tokens = clientTokens.get(client.sourceId) || new Set();
      const overlap = intersectionSize(tokens, associateTokens);
      const mentionsClient = normalizeText(associate.description).includes(normalizeText(client.name));
      let score = 0;

      score += Math.max(0, 35 - rowDistance);
      score += overlap * 10;
      if (mentionsClient) {
        score += 15;
      }
      if (associate.projectKey === client.projectKey) {
        score += 25;
      }

      if (score > bestScore) {
        bestScore = score;
        bestClient = client;
      }
    }

    if (bestClient && bestScore >= 20) {
      bestClient.linkedAssociateEvents.push(associate);
    }
  }
}

function buildCommission(event, index) {
  const linkedAgents = unique((event.linkedAssociateEvents || []).map((item) => item.name));
  const distribution = {};

  for (const associate of event.linkedAssociateEvents || []) {
    if (!distribution[associate.name]) {
      distribution[associate.name] = {
        amount: 0,
        percent: 0,
        paid: true,
      };
    }
    distribution[associate.name].amount += associate.amount || 0;
  }

  const buildBase = event.description || event.label;
  const buildName = `${buildBase}${event.type === "deposit" ? " [Acompte]" : ""}`.trim();
  const worldName = `c-import-${slugify(event.name || "commission")}-${slugify(event.month)}-${String(index + 1).padStart(3, "0")}`;
  const notes = [
    `Import historique depuis Comptabilité Lusciana.xlsx`,
    `Mois: ${event.month}`,
    `Ligne source: ${event.row}`,
    `Type source: ${event.type}`,
    `Libelle: ${event.label}`,
    `Description: ${event.description || "N/A"}`,
  ];

  if (linkedAgents.length > 0) {
    notes.push(`Associes detectes: ${linkedAgents.join(", ")}`);
  }

  const now = new Date().toISOString();
  return {
    legacySourceId: event.sourceId,
    buildSize: "legacy-import",
    buildName,
    worldName,
    realizedBy: linkedAgents,
    version: "",
    forCustomer: "yes",
    price: event.amount || 0,
    buildStart: "",
    buildEnd: "",
    depositPaid: event.type === "deposit" ? "yes" : "no",
    depositAmount: event.type === "deposit" ? event.amount || 0 : 0,
    buildType: "legacy",
    organics: "",
    selectedAgents: linkedAgents,
    priceDistribution: distribution,
    commissionPercent: 0,
    wentWell: "yes",
    clientName: event.name,
    clientWants: notes.join("\n"),
    hasFeedback: "no",
    clientFeedback: "",
    render: "",
    showcaseText: "",
    createdBy: "legacy-import",
    createdAt: now,
    updatedAt: now,
    legacyImport: {
      source: "Comptabilité Lusciana.xlsx",
      month: event.month,
      row: event.row,
      column: event.column,
      type: event.type,
      label: event.label,
      description: event.description,
      contextTexts: event.contextTexts,
      linkedAssociateEvents: (event.linkedAssociateEvents || []).map((item) => ({
        sourceId: item.sourceId,
        name: item.name,
        amount: item.amount,
        label: item.label,
        description: item.description,
        row: item.row,
      })),
    },
  };
}

function buildPreview(workbook) {
  const agentData = extractAgents(workbook);
  const { clientEvents, associateEvents } = scanEvents(workbook);
  linkAssociateEvents(clientEvents, associateEvents);

  const commissions = clientEvents.map((event, index) => buildCommission(event, index));

  return {
    generatedAt: new Date().toISOString(),
    sourceWorkbook: workbook.workbook,
    summary: {
      agentCount: agentData.items.length,
      clientAgentCount: agentData.clients.length,
      builderAgentCount: agentData.associates.length,
      supplierCount: agentData.suppliers.length,
      commissionCount: commissions.length,
      clientEventCount: clientEvents.length,
      associateEventCount: associateEvents.length,
    },
    agents: agentData.items,
    commissions,
    warnings: [
      "Les commissions importees correspondent aux evenements comptables client (acompte/facture), pas a un regroupement manuel projet par projet.",
      "Les roles manager/builder ne sont pas explicitement presents dans le classeur: tous les associes sont importes en builder par defaut.",
      "Les paiements fournisseurs ne sont pas importes comme agents, mais restent visibles dans les donnees sources du classeur.",
    ],
  };
}

async function writeToMongo(preview) {
  const dotenv = require(path.join(BACKEND_DIR, "node_modules", "dotenv"));
  const { MongoClient } = require(path.join(BACKEND_DIR, "node_modules", "mongodb"));

  dotenv.config({ path: path.join(BACKEND_DIR, ".env") });

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();

  try {
    const database = client.db(process.env.MONGODB_DATABASE || "lusciana");
    const agents = database.collection("agents");
    const commissions = database.collection("commissions");

    for (const agent of preview.agents) {
      const existing = await agents.findOne({ pseudo: agent.pseudo });
      if (existing) {
        await agents.updateOne(
          { _id: existing._id },
          {
            $set: {
              category: existing.category || agent.category,
              updatedAt: new Date(),
              legacyImport: {
                ...(existing.legacyImport || {}),
                ...(agent.legacyImport || {}),
              },
            },
            $setOnInsert: {
              createdAt: new Date(agent.createdAt),
            },
          }
        );
      } else {
        await agents.insertOne({
          ...agent,
          createdAt: new Date(agent.createdAt),
          updatedAt: new Date(agent.updatedAt),
        });
      }
    }

    for (const commission of preview.commissions) {
      await commissions.updateOne(
        { "legacyImport.source": "Comptabilité Lusciana.xlsx", "legacyImport.month": commission.legacyImport.month, "legacyImport.row": commission.legacyImport.row, "legacyImport.column": commission.legacyImport.column, "legacyImport.type": commission.legacyImport.type },
        {
          $set: {
            ...commission,
            createdAt: new Date(commission.createdAt),
            updatedAt: new Date(commission.updatedAt),
          },
        },
        { upsert: true }
      );
    }
  } finally {
    await client.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  exportWorkbook(args);
  const workbook = readJson(args.workbookJson);
  const preview = buildPreview(workbook);

  ensureDirectory(args.output);
  fs.writeFileSync(args.output, JSON.stringify(preview, null, 2));

  if (args.write) {
    await writeToMongo(preview);
  }

  process.stdout.write(
    JSON.stringify(
      {
        output: args.output,
        summary: preview.summary,
        write: args.write,
      },
      null,
      2
    ) + "\n"
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
