#!/usr/bin/env python3
"""Exercise rapid sequential POSTs with the benchmark's actual Java HTTP client."""
from http.server import BaseHTTPRequestHandler,HTTPServer
import importlib.util
from pathlib import Path
import subprocess
import threading
import time

ROOT=Path(__file__).resolve().parent.parent
sp=importlib.util.spec_from_file_location('model',Path(__file__).with_name('gemma-v2-model.py'))
m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):
        self.rfile.read(int(self.headers['Content-Length']))
        m.respond_json(self,{'ok':True})
        time.sleep(.03) # Cleanup after writing must not create a stale reuse race.
server=HTTPServer(('127.0.0.1',8766),Handler)
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
out=ROOT/'.tools/finetune/gemma4-e2b-v2/http-check';out.mkdir(exist_ok=True)
source=out/'HttpCheck.java'
source.write_text('''import java.net.URI;
import java.net.http.*;
public class HttpCheck {
 public static void main(String[] args) throws Exception {
  var c=HttpClient.newHttpClient();
  for(int i=0;i<100;i++) {
   var q=HttpRequest.newBuilder(URI.create("http://127.0.0.1:8766/check")).POST(HttpRequest.BodyPublishers.ofString("{}" )).build();
   var r=c.send(q,HttpResponse.BodyHandlers.ofString());
   if(r.statusCode()!=200 || !r.body().contains("true")) throw new RuntimeException("Bad response "+i);
  }
  System.out.println("100 rapid Java HTTP POSTs passed, including delayed server cleanup.");
 }
}''')
try:subprocess.run([str(ROOT/'.tools/android/jdk21/bin/java'),str(source)],check=True)
finally:server.shutdown();thread.join();server.server_close()
