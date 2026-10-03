// CSV cells are quoted and formula-looking values are forced to text in spreadsheet apps.
export function csvCell(value:unknown):string {
  let text=String(value??"");
  if(/^[\s]*[=+\-@]/u.test(text)||/^[\t\r\n]/u.test(text))text="'"+text;
  return `"${text.replaceAll('"','""')}"`;
}

export function personalCsv(rows:readonly [string,string,string,unknown][]):string {
  return "\uFEFF"+["record_type,record_id,field,value",...rows.map(row=>row.map(csvCell).join(","))].join("\r\n")+"\r\n";
}
