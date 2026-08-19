(async()=>{
  try{
    const Impl=require('C:/Users/Ritesh/Documents/projects/secureOTA/upstream/arduino-ide-2.3.9/arduino-ide-extension/lib/node/github-service-impl.js').GitHubServiceImpl;
    const s=new Impl();
    const fetch=require('C:/Users/Ritesh/Documents/projects/secureOTA/upstream/arduino-ide-2.3.9/node_modules/node-fetch');
    const owner=await s.getUsername();
    const repo='secureota-e2e-' + Date.now();
    const tag = 'v' + Date.now();
    const headers=await s.getAuthHeaders();
    console.log('owner',owner);
    console.log('repo',repo);
    console.log('tag',tag);
    const url=`https://api.github.com/repos/${owner}/${repo}/releases`;
    console.log('POST',url);
    const resp=await fetch(url,{method:'POST',headers,body:JSON.stringify({tag_name:tag,name:tag,draft:false,prerelease:false})});
    console.log('status',resp.status,resp.statusText);
    const text=await resp.text();
    console.log('body',text);
  }catch(e){console.error('ERR',e&&e.message);console.error(e&&e.stack)}
})();
