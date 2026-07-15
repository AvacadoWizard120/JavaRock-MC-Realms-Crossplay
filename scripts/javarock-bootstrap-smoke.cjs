'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const startBat = fs.readFileSync(path.join(root, 'START-JAVAROCK.bat'), 'utf8')
const bootstrap = fs.readFileSync(path.join(__dirname, 'Start-JavaRock.ps1'), 'utf8')
const installer = fs.readFileSync(path.join(__dirname, 'Install-JavaRockRequirements.ps1'), 'utf8')

assert.match(startBat, /Start-JavaRock\.ps1/i)
assert.match(bootstrap, /MessageBoxButtons\]::YesNo/)
assert.match(bootstrap, /Choosing No installs nothing/)
assert.match(bootstrap, /-Verb RunAs/)
assert.match(bootstrap, /npm.*ci|Invoke-Npm[\s\S]*@\('ci'/)
assert.match(bootstrap, /\.npm-cache/)
assert.match(bootstrap, /npm.*run.*setup|@\('run', 'setup'\)/)
assert.match(bootstrap, /pythonw\.exe/)
assert.match(installer, /OpenJS\.NodeJS\.LTS/)
assert.match(installer, /EclipseAdoptium\.Temurin\.17\.JDK/)
assert.match(installer, /Python\.Python\.3\.12/)
assert.match(installer, /accept-package-agreements/)
assert.doesNotMatch(startBat + bootstrap, /bridge-gui|localhost:8765/i)

console.log('JavaRock bootstrap smoke check passed.')
