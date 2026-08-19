(async()=>{
  try{
    const Impl=require('C:/Users/Ritesh/Documents/projects/secureOTA/upstream/arduino-ide-2.3.9/arduino-ide-extension/lib/node/github-service-impl.js').GitHubServiceImpl;
    const s=new Impl();
    const fetch=require('C:/Users/Ritesh/Documents/projects/secureOTA/upstream/arduino-ide-2.3.9/node_modules/node-fetch');
    const owner=await s.getUsername();
    const repo='secureota-e2e-initialize-1786642836976';
    const headers=await s.getAuthHeaders();
    const resp=await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`,{headers});
    if(!resp.ok){console.error('status',resp.status); console.error(await resp.text()); process.exit(2);} const j=await resp.json();
    console.log('release',j.html_url);
    if(j.assets && j.assets.length) console.log('asset',j.assets[0].browser_download_url);
  }catch(e){console.error(e&&e.message);}
})();
