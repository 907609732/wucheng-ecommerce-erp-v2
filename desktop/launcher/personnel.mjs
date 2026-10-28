const roles=Object.freeze({boss:'老板',employee:'员工'});

export function validatePersonnelRole(role,{allowEmpty=false}={}){
  if(allowEmpty&&role===null)return null;
  if(typeof role!=='string'||!Object.hasOwn(roles,role))throw Error('请选择老板或员工身份');
  return role;
}

// This choice belongs to the running main process, never localStorage or disk.
export function createPersonnelSelection({resetViews=()=>{},clearPages=async()=>{}}={}){
  let role=null,changing=false;
  const state=()=>({role,selected:role!==null,label:roles[role]||'请选择身份'});
  const requireSelected=()=>{
    if(changing||role===null)throw Object.assign(Error(changing?'正在切换身份，请稍候':'请先选择老板或员工身份'),{code:'PERSONNEL_REQUIRED'});
    return role;
  };
  return {
    state,requireSelected,
    requireBoss(){if(requireSelected()!=='boss')throw Object.assign(Error('成员权限和销售台离线快照仅老板可以查看'),{code:'PERSONNEL_BOSS_REQUIRED'});},
    async select(next){
      validatePersonnelRole(next,{allowEmpty:true});
      if(changing)throw Error('正在切换身份，请稍候');
      changing=true;const previous=role;role=null;
      try{await resetViews();await clearPages({previous,next});role=next;return state();}
      finally{changing=false;}
    }
  };
}

export function personnelPartition(id,basePartition,role){
  return id==='sales'?basePartition+'-personnel-'+validatePersonnelRole(role):basePartition;
}

export function decoratePersonnelURL(id,value,role){
  if(id!=='sales')return value;
  const url=new URL(value);url.searchParams.set('identity',validatePersonnelRole(role));return url.href;
}

export function assertPersonnelSupport(info){
  if(info?.required!==true)throw Object.assign(Error('销售台需要更新：当前服务尚未支持老板与员工身份，请先更新工作台和销售台。'),{code:'PERSONNEL_UPDATE_REQUIRED'});
  return info;
}
