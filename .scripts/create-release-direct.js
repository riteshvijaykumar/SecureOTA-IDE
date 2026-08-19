(async()=>{
  try{
    const fetch=require('C:/Users/Ritesh/Documents/projects/secureOTA/upstream/arduino-ide-2.3.9/node_modules/node-fetch');
    const Impl=require('C:/Users/Ritesh/Documents/projects/secureOTA/upstream/arduino-ide-2.3.9/arduino-ide-extension/lib/node/github-service-impl.js').GitHubServiceImpl;
    const s=new Impl();
    const owner=await s.getUsername();
    const repo='secureota-e2e-create-1786641645910';
    const headers=await s.getAuthHeaders();
    const url=`https://api.github.com/repos/${owner}/${repo}/releases`;
    const resp=await fetch(url,{method:'POST',headers,body:JSON.stringify({tag_name:'v1',name:'v1'})});
    console.log('status',resp.status,resp.statusText);
    const j=await resp.json();
    console.log(JSON.stringify(j,null,2));
  }catch(e){console.error('ERR',e&&e.message);console.error(e&&e.stack);} 
})();
