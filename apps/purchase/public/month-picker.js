export function mountChineseMonthPickers(root=document){
 const inputs=root.querySelectorAll('input[data-month-picker]');
 if(typeof window.flatpickr!=='function'||typeof window.monthSelectPlugin!=='function')return;
 for(const input of inputs){
  if(input._flatpickr)continue;
  window.flatpickr(input,{
   locale:window.flatpickr.l10ns.zh,
   dateFormat:'Y-m',
   altInput:true,
   altFormat:'Y年n月',
   altInputClass:'month-picker-input',
   allowInput:false,
   disableMobile:true,
   plugins:[new window.monthSelectPlugin({shorthand:false,dateFormat:'Y-m',altFormat:'Y年n月'})],
  });
 }
}
