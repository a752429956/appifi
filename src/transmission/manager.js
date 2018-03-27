const { spawn, spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const EventEmitter = require('events')
const Transmission = require('transmission')
const bluebird = require('bluebird')
const getFruit = require('../fruitmix')

bluebird.promisifyAll(fs)

class Manager extends EventEmitter{
  constructor(tempPath) {
    super()
    this.tempPath = tempPath // 下载缓存目录
    this.storagePath = path.join(this.tempPath, 'storage.json') // 下载信息存储
    this.client = null // 所有下载任务同用一个下载实例
    this.downloading = [] // 下载任务列表
    this.downloaded = [] // 完成列表
    this.moveReadyQueue = [] 
    this.movingQueue = []
    this.writing = false // 是否正在更新记录文件
    this.lockNumber = 0 // 等待更新数量
    this.lock = false // 存储任务锁
    this.errors = [] // 错误列表
  }

  // 初始化
  init() {
    // 检查transmission-daemon 
    try {
      let command = 'systemctl'
      let serviceName = 'transmission-daemon'
      // 尝试启动服务
      spawnSync(command, ['enable', serviceName])
      spawnSync(command, ['start', serviceName])
      // 检查服务状态
      let enableResult = spawnSync(command, ['is-enabled', serviceName]).stdout.toString()
      let activeResult = spawnSync(command, ['is-active', serviceName]).stdout.toString()
      if (enableResult.indexOf('enabled') === -1) this.error(enableResult.stderr.toString())
      if (activeResult.indexOf('active') === -1) return this.error(enableResult.stderr.toString())
      console.log('transmission init')
    } catch (error) { 
      console.log(error)
      this.error(error)
     }
    // 实例化Transmission
    this.client = new Transmission({
      host: 'localhost',
      port: 9091,
      username: 'transmission',
      password: '123456'
    })
    bluebird.promisifyAll(this.client)
    // 设置transmission属性
    this.client.session({
      seedRatioLimit: 1,
      seedRatioLimited: true,
      'idle-seeding-limit': 30,
      'idle-seeding-limit-enabled': false,
      'speed-limit-up-enabled': false,
      'speed-limit-down-enabled': false
    }, () =>{})
    // 读取缓存文件， 创建未完成任务
    if (!fs.existsSync(this.storagePath)) return
    let tasks = JSON.parse(fs.readFileSync(this.storagePath))

    this.downloaded = tasks.downloaded.map(task => {
      let { id, dirUUID, userUUID, name, finishTime } = task
      return new Task(id, dirUUID, userUUID, name, this, finishTime)
    })
    
    this.downloading = tasks.downloading.map(task => {
      let { id, dirUUID, userUUID } = task
      return new Task(id, dirUUID, userUUID, null, this)
    })
  }

  // 错误处理
  error(arg) {
    let err = typeof arg === 'object'? arg: new Error(arg)
    this.errors.push(err)
    this.emit('error', err) 
  }

  // 同步transmission 任务数据
  syncList() {
    setInterval(() => {
      this.client.get((err, arg) => {
        let tasks = arg.torrents
        let errArr = []
        this.downloading.forEach((item) => {
          let result = tasks.find(task => task.id == item.id)
          if (result) item.set(result)
          // 无法在transmission任务列表中找到对应任务， 移除本地任务
          else errArr.push(item)
        })
        // 从队列中移除错误任务
        errArr.forEach(async item => {
          let index = this.downloading.indexOf(item)
          this.downloading.splice(index,1)
          await this.cache()
        })
      })
    },1000)
  }

  /* task object
    * hashString: hash of task
    * id: task id in transmission
    * name: task name
  */

  // 创建磁链、种子下载任务
  async createTransmissionTask(type, source, dirUUID, userUUID) {
    try {
      // 创建transmission任务
      let result, options = { "download-dir": this.tempPath }
      if (type === 'magnet') result = await this.client.addUrlAsync(source, options)
      else result = await this.client.addFileAsync(source, options)
      // 检查当前用户是否已创建过相同任务
      let resultInDownloading = this.downloading.find(item => item.id == result.id && item.userUUID == userUUID)
      // let resultInDownloaded = this.downloaded.find(item => item.id == result.id && item.userUUID == userUUID)
      if (resultInDownloading) return console.log('exist same task')
      // 创建本地任务
      else await this.taskFactory(result.id, dirUUID, userUUID, this)
      return result
    } catch (e) {
      let errMessage = e.message
      console.log(e)
    }
  }

  // 创建任务对象(创建、存储、监听)
  async taskFactory(id, dirUUID, userUUID) {
    try {
      // 创建
      let tasks = await this.get(id)
      if (tasks.torrents.length !== 1) throw new Error('create task error')
      else { let taskObj = tasks.torrents }
      let task = new Task(id, dirUUID, userUUID, null, this)
      // 存储
      this.downloading.push(task)
      await this.cache()
    } catch (err) {
      throw err
    }
  }

  // 存储任务信息
  async cache() {
    if (this.lock) {
      // 有文件正在写入
      this.lockNumber++
    } else {
      // 写入操作
      this.lock = true
      this.lockNumber = 0
      let storageObj = {
        downloading: this.downloading.map(file => file.getInfor()),
        downloaded: this.downloaded.map(file => file.getInfor())
      }
      await fs.writeFileAsync(this.storagePath, JSON.stringify(storageObj, null, '\t'))
      this.lock = false
      // 检查被阻塞的写入操作
      if (this.lockNumber) this.cache()
    }
  }

  // 查询所有任务
  getList() {
    return {
      downloading: this.downloading.map(item => item.getSummary()), 
      downloaded: this.downloaded.map(item => item.getFinishInfor())
    }
  }

  // 查询任务
  async get(id) {
    try {
      if (id) return await this.client.getAsync(id)
      else return await this.client.getAsync()
    }catch (e) {
      // todo
      console.log(e)
    }
  }

  // 暂停、开始、删除任务
  op(id, userUUID, op, callback) {
    // 检查参数op
    let ops = ['pause', 'resume', 'destroy']
    if(!ops.includes(op)) callback(new Error('unknow error'))
    // 检查对应任务是否存在
    let indexCallback = item => item.id == id && item.userUUID == userUUID
    let indexOfDownloading = this.downloading.findIndex(indexCallback)
    let indexOfDownloaded = this.downloaded.findIndex(indexCallback)
    let notFoundErr = new Error('can not found task')
    let opCallback = (err, data) => {
      if (err) callback(err)
      else callback(data)
    }
    console.log(indexOfDownloading, indexOfDownloaded)
    switch(op) {
      // 暂停任务
      case 'pause':
        if (indexOfDownloading == -1) return callback(notFoundErr)
        this.client.stop(id, opCallback)
        break
      // 开始任务
      case 'resume':
      if (indexOfDownloading == -1) callback(notFoundErr)
        this.client.start(id, opCallback)
        break
      // 删除任务
      case 'destroy':
        if (indexOfDownloading !== -1) {
          this.client.remove(id, true, (err, data) => {
            if (err) return callback(err)
            // 删除内存中对象
            this.downloading.splice(indexOfDownloading, 1)
            // 保存
            this.cache().then(() => {callback()})
            .catch(err => callback(err))
          })
        }else if (indexOfDownloaded !== -1) {
          // 删除内存中对象
          this.downloaded.splice(indexOfDownloaded, 1)
          // 保存
          this.cache().then(() => {callback()})
          .catch(err => callback(err))
        } else callback(notFoundErr)
        break
      default:
        callback(notFoundErr)
    }
  }

  enterFinishState(task) {
    let index = this.downloading.indexOf(task)
    let result = this.downloading.splice(index,1)[0]
    result.finishTime = (new Date()).getTime()
    this.downloaded.push(result)
    this.cache()
  }


  // 对下载完成需要进行拷贝的任务进行排队
  // 添加任务到准备队列
  addToMoveQueue(task) {
    // 检查任务是否已存在与队列中
    if (task.state !== 'downloading') return
    this.moveReadyQueue.push(task)
    task.state = 'willMove'
    // 使用调度器
    this.scheduleMove()
  }

  // 将拷贝完成的任务从队列中移除
  removeFromMovingQueue(task) {
    let index = this.movingQueue.indexOf(task)
    if (index == -1) return console.log('exist error ')
    this.movingQueue.splice(index, 1)
    this.scheduleMove()
  }

  // 调度拷贝任务
  scheduleMove() {
    while( this.moveReadyQueue.length > 0 && this.movingQueue.length == 0) {
      let task = this.moveReadyQueue.shift()
      if (!task ) return
      this.movingQueue.push(task)
      task.move()
    }
  }
}

class Task {
  constructor(id, dirUUID, userUUID, name, manager, finishTime) {
    this.id = id // 任务id
    this.dirUUID = dirUUID // 下载目标目录
    this.userUUID = userUUID // 用户uuid
    this.downloadDir = '' // 下载临时目录
    this.name = name? name: '' // 任务名称
    this.rateDownload = null //下载速率
    this.rateUpload = null // 上传速率
    this.percentDone = 0 // 完成比例
    this.eta = Infinity // 剩余时间
    this.status = null // 当前状态(in transmission)
    this.manager = manager // 容器
    this.state = 'downloading' // 本地状态(downloading/moving/finish)
    this.finishTime = finishTime? finishTime: null // 任务完成时间
  }

  // 与transmission中对应任务进行同步，判断是否完成
  set(task) {
    let { downloadDir, name, rateDownload, rateUpload, percentDone, eta, status } = task
    let nextState = { downloadDir, name, rateDownload, rateUpload, percentDone, eta, status }
    Object.assign(this, nextState)
    this.judeProgress(task)
  }
  
  // 判断下载任务是否完成
  judeProgress(task) {
    // 本地任务处于移动或完成状态，跳过
    if (this.state !== 'downloading') return
    // 完成条件1 任务标记为完成
    let conditionA = task.isFinished
    // 完成条件2 任务进入了seed状态
    let conditionB = [5,6].includes(task.status)
    // 完成条件3 任务处于暂停状态、完成度为100%
    let conditionC = task.status == 0 && task.percentDone == 1
    // 进行移动等操作
    if (conditionA || conditionB || conditionC) this.manager.addToMoveQueue(this)
  }

  // 获取任务关键信息， 存储用
  getInfor() {
    let { id, dirUUID, userUUID, finishTime, name } = this
    return { id, dirUUID, userUUID, finishTime, name }
  }

  // 获取任务基本信息， 查询用
  getSummary() {
    let { name, dirUUID, rateDownload, percentDone, eta, status } = this
    return { name, dirUUID, rateDownload, percentDone, eta, status }
  }

  // 获取完成任务的基本信息， 查询用
  getFinishInfor() {
    let { name, dirUUID, finishTime } = this
    return { name, dirUUID, finishTime }
  }

  move() {
    try {
      this.state = 'moving'
      let tmpPath = path.join(this.downloadDir, this.name) // 获取下载文件的临时目录
      let fruitmix = getFruit() // 获取fruitmix实例
      let user = { uuid: this.userUUID } // 构造user对象用于查询
      let drive = fruitmix.getDrives(user).find(item => item.tag == 'home') // 获取用户home对象
      let targetDirPath = fruitmix.getDriveDirPath(user, drive.uuid, this.dirUUID) // 获取用户下载目标目录路径
      let targetPath = this.getName(targetDirPath, this.name)  // 检查目标路径是否有相同文件名并重命名
      console.log('文件临时目录: ', tmpPath, '\n', '文件目标目录: ', targetPath)
      let cp = spawn('cp', ['-rf', tmpPath, targetPath])
      cp.stderr.on('data', data => console.log(data.toString(), 'err')) // 错误处理 todo
      cp.on('exit', code => {
        console.log('退出码是: ', code)
        fruitmix.driveList.getDriveDir(drive.uuid, this.dirUUID)
        this.manager.removeFromMovingQueue(this)
        this.manager.enterFinishState(this)
      })
    } catch (e) {
      console.log(e)
    }
  }

  getName(dirPath, fileName) {
    let newName, index = 0
    let isFIleExist = () => {
      try {
        let nameArr = fileName.split('.')
        if (nameArr.length > 1) {
          nameArr[nameArr.length - 2] += (index==0?'':'(' + (index + 1) + ')')
          newName = path.join(dirPath, nameArr.join('.'))
        }else {
          newName = path.join(dirPath, nameArr[0] + (index==0?'':'(' + (index + 1) + ')'))
        }
        let exist = fs.existsSync(newName)
        if (!exist) return newName
        else {
          console.log('file exist rename', index)
          index++
          return isFIleExist()
        }
      }catch(e) {console.log(e)}
    }
    return isFIleExist()
  }

}

module.exports = Manager
