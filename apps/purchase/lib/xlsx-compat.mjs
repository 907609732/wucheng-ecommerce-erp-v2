import * as XLSX from 'xlsx';

// Some exporters use namespace-prefixed OOXML that ExcelJS cannot parse.
// Read cell values directly: sheet_to_json's local Date conversion can shift
// timezone-free Excel dates to the preceding day.
export function readCompatibleXlsx(buffer){
 if(buffer[0]!==0x50||buffer[1]!==0x4b)throw Error('无法读取 Excel 文件，请确认文件为有效的 .xlsx');
 const wb=XLSX.read(buffer,{cellDates:false,cellNF:true});
 return wb.SheetNames.map(name=>{
  const sheet=wb.Sheets[name];if(!sheet['!ref'])return {name,rows:[]};
  const range=XLSX.utils.decode_range(sheet['!ref']);
  if(range.e.r>50020||range.e.c>2000)throw Error('表格范围过大，请按订单分批导出');
  const rows=Array.from({length:range.e.r+1},(_,r)=>Array.from({length:range.e.c+1},(_,c)=>{
   const cell=sheet[XLSX.utils.encode_cell({r,c})];if(!cell)return '';
   if(cell.t==='e')return cell.w||'#VALUE!';
   if(cell.t==='n'&&XLSX.SSF.is_date(cell.z||''))return XLSX.SSF.format('yyyy-mm-dd hh:mm:ss',cell.v,{date1904:!!wb.Workbook?.WBProps?.date1904});
   return cell.v??'';
  }));
  for(const merge of sheet['!merges']||[]){
   if(merge.e.r>range.e.r||merge.e.c>range.e.c)continue;
   const value=rows[merge.s.r][merge.s.c];
   for(let r=merge.s.r;r<=merge.e.r;r++)for(let c=merge.s.c;c<=merge.e.c;c++)if(rows[r][c]==='')rows[r][c]=value;
  }
  return {name,rows};
 });
}
