"""CLI access to the identical named tools exposed by the MCP server."""
import asyncio,base64,json
from pathlib import Path

def call(roots,tool,arguments,*,sessions=None,output=None):
    from mcp_server import build_mcp_server
    live=None
    if sessions:
        from agent_live_client import MultiSessionLiveClient
        live=MultiSessionLiveClient(sessions)
    server,_=build_mcp_server(roots,live_client=live)
    try:result=asyncio.run(server.call_tool(tool,arguments))
    except Exception as error:raise ValueError(str(error)[:1000]) from None
    value=result.model_dump(mode='json',exclude_none=True)
    images=[block for block in value.get('content',[]) if block.get('type')=='image']
    if images:
        if not output:raise ValueError('This tool returns images; provide --output with a new PNG filename')
        if len(images)!=1:raise ValueError('This tool returned multiple images; retrieve them individually')
        image=images[0];path=Path(output).absolute()
        from agent_documents import DocumentStore
        path=DocumentStore(roots).resolve(path,must_exist=False)
        if path.exists() or path.suffix.lower()!='.png' or image.get('mimeType',image.get('mime_type'))!='image/png':raise ValueError('Choose a new .png output filename')
        from documents import atomic_write
        with path.open('xb') as handle:handle.write(base64.b64decode(image['data'],validate=True))
        value['content']=[block for block in value['content'] if block.get('type')!='image']
        value['imageOutput']=str(path)
    return value
