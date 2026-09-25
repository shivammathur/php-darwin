from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import hashlib,json,subprocess,time
objects=[('memcached-7.3-debug-zts-arm64-bbee09af38009da16745c101573ae8476c45bfa63231d84af88d5e5b61a15e44.tar.zst',4026565,'bbee09af38009da16745c101573ae8476c45bfa63231d84af88d5e5b61a15e44'),('imagick-8.6-debug-zts-arm64-7e5965789299af1ae294821c1677e0430cad568ef928e1666585ef6181155dc2.tar.zst',12888946,'7e5965789299af1ae294821c1677e0430cad568ef928e1666585ef6181155dc2')]
origins={'github':'https://github.com/shivammathur/php-darwin/releases/download/extensions','cloudflare':'https://artifacts.php-darwin.setup-php.com/extensions','cloudflare-query':'https://artifacts.php-darwin.setup-php.com/extensions'}
def probe(case):
 (name,size,sha),(label,base)=case;file=Path(label+'-'+sha);headers=Path(str(file)+'.headers')
 url=base+'/'+name+('?verify='+str(time.time_ns()//1000000) if label=='cloudflare-query' else '')
 result=subprocess.run(['curl','-q','--silent','--show-error','--location','--connect-timeout','5','--max-time','45','--proto','=https','--proto-redir','=https','--output',str(file),'--dump-header',str(headers),'--write-out','%{json}',url],capture_output=True,text=True)
 info=json.loads(result.stdout);data=file.read_bytes() if file.exists() else b'';actual=hashlib.sha256(data).hexdigest()
 selected={}
 for line in headers.read_text().splitlines():
  key,_,value=line.partition(':')
  if key.lower() in ('cf-ray','cf-cache-status','age','server','content-length','content-range'):selected[key.lower()]=value.strip()
 record={'name':name,'origin':label,'exit':result.returncode,'http':info['http_code'],'seconds':info['time_total'],'first_byte_seconds':info['time_starttransfer'],'bytes':len(data),'sha256':actual,'headers':selected,'stderr':result.stderr.strip(),'passed':result.returncode==0 and info['http_code']==200 and len(data)==size and actual==sha}
 file.unlink(missing_ok=True);headers.unlink(missing_ok=True)
 return record
with ThreadPoolExecutor(max_workers=6) as pool:records=list(pool.map(probe,[(o,b) for o in objects for b in origins.items()]))
Path('report.json').write_text(json.dumps(records,indent=2)+'\n')
print(json.dumps(records,indent=2))
raise SystemExit(0 if all(r['passed'] for r in records) else 1)
