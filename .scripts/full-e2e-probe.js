(async()=>{
  try{
    const Impl=require('C:/Users/Ritesh/Documents/projects/secureOTA/upstream/arduino-ide-2.3.9/arduino-ide-extension/lib/node/github-service-impl.js').GitHubServiceImpl;
    const s=new Impl();
    const fetch=require('C:/Users/Ritesh/Documents/projects/secureOTA/upstream/arduino-ide-2.3.9/node_modules/node-fetch');
    const fs=require('fs');
    const path=require('path');
    const owner=await s.getUsername();
    const repo='secureota-e2e-full-' + Date.now();
    console.log('owner',owner,'repo',repo);

    const headers=await s.getAuthHeaders();
    // check repo
    let resp=await fetch(`https://api.github.com/repos/${owner}/${repo}`,{headers});
    console.log('GET repo status',resp.status);
    if(resp.status===404){
      console.log('Creating repo...');
      const createResp=await fetch('https://api.github.com/user/repos',{method:'POST',headers,body:JSON.stringify({name:repo,private:false})});
      console.log('create status',createResp.status);
      console.log(await createResp.text());
    } else {
      console.log('Repo exists');
    }
    // create release
    const tag = 'v' + Date.now();
    resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`,{method:'POST',headers,body:JSON.stringify({tag_name:tag,name:tag,draft:false,prerelease:false})});
    console.log('create release status',resp.status); const releaseText=await resp.text(); console.log('release body',releaseText);

    // if release created, try upload
    try{
      const release = JSON.parse(releaseText);
      if(release.upload_url){
        const sampleDir = path.resolve(__dirname,'..','upstream','arduino-ide-2.3.9','tmp'); if(!fs.existsSync(sampleDir)) fs.mkdirSync(sampleDir,{recursive:true});
        const sampleBin = path.join(sampleDir,'probe.bin'); fs.writeFileSync(sampleBin,Buffer.from('data'));
        const uploadUrl = release.upload_url.replace('{?name,label}',`?name=${encodeURIComponent(path.basename(sampleBin))}`);
        const data=fs.readFileSync(sampleBin);
        const upResp = await fetch(uploadUrl,{method:'POST',headers:Object.assign({},headers,{ 'Content-Type': 'application/octet-stream','Content-Length':String(data.length)}),body:data});
        console.log('upload status',upResp.status,await upResp.text());
      }
    }catch(e){console.log('skip upload - release not JSON',e&&e.message)}

  }catch(e){console.error('ERR',e&&e.message);console.error(e&&e.stack)}
})();
