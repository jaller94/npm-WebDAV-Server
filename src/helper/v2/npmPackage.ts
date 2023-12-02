import * as path from 'node:path'
import * as fs from 'node:fs'

let pkg : any = undefined;

export function getPackageData(callback : (e : Error, data ?: any) => void)
{
    if(pkg)
    {
        callback(undefined, pkg);
        return;
    }

    const packagePath = path.resolve(path.join(__dirname, '..', '..', '..', 'package.json'));

    fs.readFile(packagePath, (e, data) => {
        try
        {
            if(e)
                throw e;
            
            if(data)
            {
                pkg = JSON.parse(data.toString());

                callback(undefined, pkg);
            }
        }
        catch(ex)
        {
            callback(ex);
        }
    })
}
