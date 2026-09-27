import fs from "node:fs";
import XLSX from "xlsx";

// SheetJS ESM builds do not automatically bind Node's filesystem adapter.
// Register it once so imports and generated audit workbooks behave consistently.
if (typeof XLSX.set_fs === "function") XLSX.set_fs(fs);

export default XLSX;
