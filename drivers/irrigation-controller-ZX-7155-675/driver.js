'use strict';

const { Driver } = require('homey');
const { ZigBeeDriver } = require("homey-zigbeedriver");

class MyDriver extends ZigBeeDriver {

  async onInit() {
    this.log('MyDriver has been initialized');

    const cardActionOnfordelay = this.homey.flow.getActionCard('smart-irrigation-system-start-for-x-minutes');
    cardActionOnfordelay.registerRunListener(async (args) => {
      let DelayInSeconds = (args.units == "s")? args.delay : args.delay*60;
      args.device.runfordelay(DelayInSeconds);
    })

  }

}

module.exports = MyDriver;
