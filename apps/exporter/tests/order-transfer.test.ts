import {it,expect} from 'vitest'
import {transferSnapshot} from '../src/core/order-transfer'
import type {Task,Order} from '../src/shared/types'
const task={id:'t',platform:'taobao',account:'当前账号',accountKey:'a'.repeat(64),accountCookie:'PRIVATE_COOKIE_NAME',from:'2026-10-01',to:'2026-10-20',status:'completed',listOutcome:'complete',count:1,updatedAt:'2026-10-20'} as Task
const order={id:'999999999999999999999999',platform:'taobao',paidFen:12345,refundFen:null,items:[{id:'1',quantity:2},{id:'2',quantity:1}]} as Order
it('transfer retains every item, unknown amounts and string IDs without credential metadata',()=>{
 const a=transferSnapshot(task,[order]),b=transferSnapshot(task,[order])
 expect(a.digest).toBe(b.digest);expect(JSON.stringify(a)).not.toContain('PRIVATE_COOKIE_NAME');expect(a.orders[0].id).toBe(order.id);expect(a.orders[0].refundFen).toBeNull();expect(a.orders[0].items).toHaveLength(2)
 expect(transferSnapshot({...task,updatedAt:'changed'},[order]).digest).not.toBe(a.digest)
})
it('running tasks cannot transfer and legacy completeness remains explicitly unverified',()=>{
 expect(()=>transferSnapshot({...task,status:'running'},[order])).toThrow(/先完成/)
 expect(transferSnapshot({...task,listOutcome:undefined},[order]).task.listOutcome).toBe('pending')
})
