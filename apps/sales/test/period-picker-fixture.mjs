import {parsePeriod} from '../public/ui/period-picker.mjs';
// Presentation adapter for HTML-only business-state tests; DOM interactions are tested in the browser.
export function periodPickerFixture(period){
 let selected=period;
 const picker={get:()=>({grain:'month',period:selected}),set:({grain,period})=>{if(!parsePeriod(grain,period))return false;selected=period;return true;}};
 return {disposePeriodPickers:()=>{},mountPeriodPickers:()=>new Map([['sales-task-month',picker]])};
}
