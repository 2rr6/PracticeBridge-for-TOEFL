// Each independent synthetic command bootstraps its guard. Race tests retain an
// explicit earlier client/epoch; the production renderer keeps one per page.
export async function appFetch(input, options={}) {
  const url=new URL(input);
  if(url.hostname==='127.0.0.1' && url.pathname.startsWith('/api/') && ['POST','PUT','PATCH','DELETE'].includes(options.method?.toUpperCase())) {
    const response=await fetch(url.origin+'/api/bootstrap',{headers:{'X-PracticeBridge':'1',Origin:url.origin},redirect:'error'});
    if(!response.ok)throw Error('Synthetic client bootstrap failed');
    const {bootToken,workspaceEpoch}=await response.json();
    options={...options,headers:{'X-PracticeBridge-Token':bootToken,'X-PracticeBridge-Epoch':workspaceEpoch,...options.headers}};
  }
  return fetch(input,options);
}
