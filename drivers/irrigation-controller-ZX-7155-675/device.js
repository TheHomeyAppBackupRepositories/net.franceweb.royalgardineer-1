'use strict';

const { Device } = require('homey');
const { debug, Cluster, CLUSTER } = require("zigbee-clusters");
//const { ZigBeeDevice } = require("homey-zigbeedriver");
debug(false);

const SpecificCluster = require('./SpecificCluster');
const SpecificClusterDevice = require('./SpecificClusterDevice');

Cluster.addCluster(SpecificCluster);

const DebugMode = true;

const dataPoints = {
  OnOff: 1,
  WaterConsumtion: 5,
  xxx6: 6,
  BatteryLevel: 7,
  TimeLeft: 11,
  TimerOn: 12, //0=Off,1=On,2=Waiting
  LastDuration: 15
}

const dataTypes = {
  raw: 0, // [ bytes ]
  bool: 1, // [0/1]
  value: 2, // [ 4 byte value ]
  string: 3, // [ N byte string ]
  enum: 4, // [ 0-255 ]
  bitmap: 5, // [ 1,2,4 bytes ] as bits
};

const convertMultiByteNumberPayloadToSingleDecimalNumber = (chunks) => {
  let value = 0;

  for (let i = 0; i < chunks.length; i++) {
    value = value << 8;
    value += chunks[i];
  }

  return value;
};

const getDataValue = (dpValue) => {
  switch (dpValue.datatype) {
    case dataTypes.raw:
      return dpValue.data;
    case dataTypes.bool:
      return dpValue.data[0] === 1;
    case dataTypes.value:
      return convertMultiByteNumberPayloadToSingleDecimalNumber(dpValue.data);
    case dataTypes.string:
      let dataString = '';
      for (let i = 0; i < dpValue.data.length; ++i) {
        dataString += String.fromCharCode(dpValue.data[i]);
      }
      return dataString;
    case dataTypes.enum:
      return dpValue.data[0];
    case dataTypes.bitmap:
      return convertMultiByteNumberPayloadToSingleDecimalNumber(dpValue.data);
  }
}

var GWateringDelayInSec = "";
var PollingCronId;

class MyDevice extends SpecificClusterDevice {

  async onNodeInit({ zclNode }) {
    this.log('Smart Irrigation System has been initialized');

    zclNode.endpoints[1].clusters.tuya.on("reporting", value => this.processResponse(value));
    zclNode.endpoints[1].clusters.tuya.on("response", value => this.processResponse(value));
    
    this.registerCapabilityListener('onoff', async (OnOffValue) => {

      var WateringDelayInSec = "0";
      if (DebugMode) {console.log("GWateringDelay:",GWateringDelayInSec)};
      if (OnOffValue == false) {
        WateringDelayInSec = "0";
        if (DebugMode) {console.log("(Off)GWateringDelay:",GWateringDelayInSec)};
      } else {
        if (Number(GWateringDelayInSec) > 0) { 
          WateringDelayInSec = GWateringDelayInSec;
          if (DebugMode) {console.log("(>0)GWateringDelay:",GWateringDelayInSec)};
        } else { 
          WateringDelayInSec = this.getSetting("max_watering_time")*60;
          if (Number(WateringDelayInSec) <= 0) WateringDelayInSec = 600;
          GWateringDelayInSec = WateringDelayInSec;
          if (DebugMode) {console.log("(?)GWateringDelay:",GWateringDelayInSec)};
        }
      }
      this.SetDeviceState.call(this,OnOffValue,WateringDelayInSec);
      
    });

		if (this.isFirstInit()){
      this.setCapabilityValue('onoff', false).catch(this.error);
		}

  }

  async SetDeviceState(OnOffValue,WateringDelayInSec) {
      await this.writeBool(1, OnOffValue).catch(err => {this.error('Error when writing to device: ', err);});
      if (OnOffValue) {
        //Command is On
        await this.writeData32(11, (Number(WateringDelayInSec)+60)).catch(err => {this.error('Error when writing to device: ', err);});
        this.GoCountdown(WateringDelayInSec);
      } else {
        //Command is Off
        //Update LastDate
        let DateTime = new Intl.DateTimeFormat(this.homey.i18n.getLanguage(), {
          hour12: false, timeZone: this.homey.clock.getTimezone(),
          year: '2-digit', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).format(new Date(Date.now())).replace(',', '');
        this.setCapabilityValue('sensor_lastdate', DateTime).catch(this.error);
        //Update LastTime
        let NewValue = MinutesToSeconds(this.getCapabilityValue("sensor_wateringtime"))-MinutesToSeconds(this.getCapabilityValue('sensor_remainingtime'));
        this.setCapabilityValue('sensor_lasttime', SecondsToMinutes(NewValue)).catch(this.error);
        this.setCapabilityValue('sensor_remainingtime', SecondsToMinutes(0)).catch(this.error);
        this.setCapabilityValue('sensor_wateringtime', SecondsToMinutes(0)).catch(this.error);
        //Stop Countdown
        clearInterval(PollingCronId);
        GWateringDelayInSec = "0";
      }
  }

  async GoCountdown(WateringDelayInSec) {
    this.setCapabilityValue('sensor_wateringtime', SecondsToMinutes(WateringDelayInSec)).catch(this.error);
    this.setCapabilityValue('sensor_remainingtime', SecondsToMinutes(WateringDelayInSec)).catch(this.error);
    PollingCronId = setInterval(() => {
      let NewValue = MinutesToSeconds(this.getCapabilityValue('sensor_remainingtime'))-1
      this.setCapabilityValue('sensor_remainingtime', SecondsToMinutes(NewValue)).catch(this.error);
    }, 1000); //every 1000 ms
  }

  async processResponse(data) {

    const dp = data.dp;
    const measuredValue = getDataValue(data);
    let parsedValue = 0;

    let DateTime = new Intl.DateTimeFormat(this.homey.i18n.getLanguage(), {
      hour12: false, timeZone: this.homey.clock.getTimezone(),
      year: '2-digit', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(Date.now())).replace(',', '');

    switch (dp) {

      case dataPoints.OnOff:
        parsedValue = measuredValue;
        this.log('*****************  OnOff : ', parsedValue);
        if (parsedValue) {
          //Command is On
          if (!this.getCapabilityValue('onoff')) {
            //Status was Off
            const max_manual_watering_time = this.getSetting("max_manual_watering_time")*60;
            await this.writeData32(11, max_manual_watering_time).catch(err => {this.error('Error when writing to device: ', err);});
            this.setCapabilityValue('onoff', parsedValue).catch(this.error);
            this.GoCountdown(max_manual_watering_time)
          }
        } else {
          //Command is Off
          if (this.getCapabilityValue('onoff')) {
            //Status was On
            this.SetDeviceState(parsedValue, 0)
            this.setCapabilityValue('onoff', parsedValue).catch(this.error);
          }
        }
      break;

      /*case dataPoints.PoweronState:
        parsedValue = measuredValue;
        this.log('*****************  PoweronState : ', parsedValue);
        //this.setCapabilityValue('onoff', parsedValue).catch(this.error);
      break;*/

      case dataPoints.TimeLeft:
        parsedValue = measuredValue;
        this.log('*****************  TimeLeft : ', parsedValue);
        //if (this.getSetting("actualdelay") == "-" || this.getSetting("actualdelay") == "0") {
        if (!this.getCapabilityValue("sensor_wateringtime") || 
            this.getCapabilityValue("sensor_wateringtime") == "-" || 
            this.getCapabilityValue("sensor_wateringtime") == "0") {
          //First time delay is getted
          //this.GoCountdown(parsedValue)
        };
      break;

      case dataPoints.LastDuration:
        parsedValue = measuredValue;
        this.log('*****************  LastDuration : ', parsedValue);
        //this.setCapabilityValue('sensor_lasttime', SecondsToMinutes(parsedValue)).catch(this.error);
      break;

      case dataPoints.BatteryLevel:
        //const batteryThreshold = this.getSetting('batteryThreshold') || 20;
        parsedValue = measuredValue;
        this.log("measure_battery | powerConfiguration - batteryPercentageRemaining (%): ", parsedValue);
        if (this.hasCapability('measure_battery')) {
          this.setCapabilityValue('measure_battery', parsedValue).catch(this.error);
        };
        /*if (this.hasCapability('alarm_battery')) {
          this.setCapabilityValue('alarm_battery', (parsedValue < batteryThreshold)).catch(this.error);
        };*/
        this.setSettings({ last_measure_battery: DateTime });
        //this.AddToLog(data);
      break;

      /*case dataPoints.unknown:
        parsedValue = measuredValue;
      break;*/

      default:
        this.AddToLog(data);

        this.log(" ");
        this.log("***********************************************");
        this.log("TUYA DATA :", data);
        this.log("***********************************************");
        this.log(" ");
      break;

    }
  }

	/*onBatteryPercentageRemainingAttributeReport(batteryPercentageRemaining) {
    const batteryThreshold = this.getSetting('batteryThreshold') || 20;
    parsedValue = measuredValue;
    this.log("**********  measure_battery | powerConfiguration - batteryPercentageRemaining (%): ", parsedValue);
    this.setCapabilityValue('measure_battery', parsedValue).catch(this.error);
    this.setCapabilityValue('alarm_battery', (parsedValue < batteryThreshold)).catch(this.error);
		let DateTime = new Intl.DateTimeFormat(this.homey.i18n.getLanguage(), {
			hour12: false, timeZone: this.homey.clock.getTimezone(),
			year: '2-digit', month: '2-digit', day: '2-digit',
			hour: '2-digit', minute: '2-digit', second: '2-digit'
		}).format(new Date(Date.now())).replace(',','');
    this.setSettings({ last_measure_battery: DateTime });
	}*/

  async AddToLog(data) {
    let DateTime = new Intl.DateTimeFormat(this.homey.i18n.getLanguage(), {
      hour12: false, timeZone: this.homey.clock.getTimezone(),
      year: '2-digit', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(Date.now())).replace(',', '');
    let last_unknown_value = this.getSetting("last_unknown_value") + "\n"
    last_unknown_value += "[" + DateTime + "] "
    last_unknown_value += "{dp: " + data.dp + "},{datatype: " + data.datatype + "},{value: " + getDataValue(data) + "}";
    this.setSettings({ last_unknown_value: last_unknown_value.slice(-1500) });
  }

  async onAdded() {
    this.log('MyDevice has been added');
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('MyDevice settings where changed');
  }

  async onRenamed(name) {
    this.log('MyDevice was renamed');
  }

  async onDeleted() {
    this.log('MyDevice has been deleted');
    console.log("PollingCronId : ",PollingCronId);
    clearInterval(PollingCronId);
  }

  async runfordelay(RunDelayInSeconds) {
    const RunDelayInMinutes = (RunDelayInSeconds / 60).toString();
    if (DebugMode) console.log('Run for '+RunDelayInMinutes+' minute(s) ('+RunDelayInSeconds+' seconds)');
    GWateringDelayInSec = RunDelayInSeconds;
    this.triggerCapabilityListener("onoff", true) .then() .catch(error => console.log(error.message))
    const RunDelayInMilSeconds = (RunDelayInSeconds + 1) * 1000;
    setTimeout(() => {
      this.triggerCapabilityListener("onoff", false)
        .then(console.log('Flow ended'))
        .catch(error => console.log(error.message))
    }, RunDelayInMilSeconds);
  }

}

function DateTime() {
  let DateTime = new Intl.DateTimeFormat(this.homey.i18n.getLanguage(), {
    hour12: false, timeZone: this.homey.clock.getTimezone(),
    year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date(Date.now())).replace(',', '');
  return DateTime;
}

function SecondsToMinutes(seconds) {
  if (!seconds || seconds <= 0) {return "-"};
  let minutes = Math.floor(seconds / 60);
  let extraSeconds = seconds % 60;
  minutes = minutes < 10 ? "0" + minutes : minutes;
  extraSeconds = extraSeconds< 10 ? "0" + extraSeconds : extraSeconds;
  return minutes + ":" + extraSeconds;
}

function MinutesToSeconds(minutes) {
  if (!minutes || ! minutes.includes(":")) {return 0};
  let minutesinseconds = Number(minutes.split(":")[0])*60 + Number(minutes.split(':')[1]);
    return minutesinseconds;
}

module.exports = MyDevice;

/*
  zigbee-clusters:cluster ep: 1, cl: tuya (61184) unknown command received: ZCLStandardHeader {
    frameControl: Bitmap [ clusterSpecific, directionToClient, disableDefaultResponse ],
    trxSequenceNumber: 76,
    cmdId: 36,
    data: <Buffer 00 00>
  } { dstEndpoint: 1 } +7s

  zigbee-clusters:endpoint ep: 1, cl: tuya (61184), error while handling frame unknown_command_received {
    meta: { dstEndpoint: 1 },
    frame: ZCLStandardHeader {
      frameControl: Bitmap [ clusterSpecific, directionToClient, disableDefaultResponse ],
      trxSequenceNumber: 76,
      cmdId: 36,
      data: <Buffer 00 00>
    }
  } +34s
*/

/*
  zigbee-clusters:endpoint ep: 1, cl: metering (1794), error while handling frame cluster_unavailable {
    meta: { dstEndpoint: 1 },
    frame: ZCLStandardHeader {
      frameControl: Bitmap [ directionToClient ],
      trxSequenceNumber: 130,
      cmdId: 10,
      data: <Buffer 00 00 25 00 00 00 00 00 00>
    }
  } +1s
    zigbee-clusters:endpoint ep: 1, cl: electricalMeasurement (2820), error while handling frame cluster_unavailable {
    meta: { dstEndpoint: 1 },
    frame: ZCLStandardHeader {
      frameControl: Bitmap [ directionToClient ],
      trxSequenceNumber: 131,
      cmdId: 10,
      data: <Buffer 05 05 21 ea 00 08 05 21 00 00 0b 05 29 00 00>
    }
  } +87ms
*/

/*
module.exports = [{
    fingerprint: [{ modelID: 'TS0601', manufacturerName: '_TZE200_akjefhj5' }, { modelID: 'TS0601', manufacturerName: '_TZE200_2wg5qrjy' }],
    model: 'ZVG1',
    vendor: 'RTX',
    description: 'Zigbee smart water valve',
    fromZigbee: [fz.ZVG1, fz.ignore_tuya_set_time, fz.ignore_basic_report],
    toZigbee: [tz.tuya_switch_state, tz.ZVG1_timer, tz.ZVG1_timer_state],
    exposes: [e.switch().setAccess('state', ea.STATE_SET), e.battery(),
        exposes.enum('timer_state', ea.STATE_SET, ['disabled', 'active', 'enabled']),
        exposes.numeric('timer', exposes.access.STATE_SET).withValueMin(0).withValueMax(240).withUnit('min')
        .withDescription('Auto off after specific time'),
        exposes.numeric('timer_time_left', exposes.access.STATE).withUnit('min')
        .withDescription('Auto off timer time left'),
        exposes.numeric('last_valve_open_duration', exposes.access.STATE).withUnit('min')
        .withDescription('Time the valve was open when state on'),
        exposes.numeric('water_consumed', exposes.access.STATE).withUnit('l')
        .withDescription('Liters of water consumed')
    ],
}, ];

*/

/*
{
  "schema": "devcap1.schema.json",
  "manufacturername": "_TZE200_2wg5qrjy",
  "modelid": "TS0601",
  "vendor": "Mercator",
  "product": "Mercator SSWM-DIMZ",
  "sleeper": false,
  "status": "Gold",
  "subdevices": [
    {
      "type": "$TYPE_ON_OFF_OUTPUT",
      "restapi": "/lights",
      "uuid": [
        "$address.ext",
        "0x01"
      ],
      "items": [
        {
          "name": "attr/id"
        },
        {
          "name": "attr/lastannounced"
        },
        {
          "name": "attr/lastseen"
        },
        {
          "name": "attr/manufacturername"
        },
        {
          "name": "attr/modelid"
        },
        {
          "name": "attr/name"
        },
        {
          "name": "attr/swversion",
          "parse": {"fn": "zcl", "ep": 1, "cl": "0x0000", "at": "0x0001", "script": "tuya_swversion.js"},
          "read": {"fn": "zcl", "ep": 1, "cl": "0x0000", "at": "0x0001"}
        },
        {
          "name": "attr/type"
        },
        {
          "name": "attr/uniqueid"
        },
        {
          "name": "state/alert",
          "default": "none",
          "public": false
        },
        {
          "name": "state/on",
          "parse": {"fn": "tuya", "dpid": 1, "eval": "Item.val = Attr.val;" },
          "write": {"fn": "tuya", "dpid": 1, "dt": "0x10", "eval": "Item.val == 1 ? 1 : 0;"},
          "read": {"fn": "tuya"},
          "refresh.interval": 300
        },
        {
          "name": "state/reachable"
        }
      ]
    }
  ]
}
*/

// subDeviceId === 'RightButtonDevice'
//console.log("subDeviceId : ",subDeviceId)
//console.log("CLUSTER : ",CLUSTER)

// Only if this is the first time this device is initialized, right after
// adding the device to Homey
/*if (this.isFirstInit() === true) {
  // Read the "onOff" attribute from the "onOff" cluster
  const currentOnOffValue = await zclNode.endpoints[1].clusters.onOff.readAttributes(
    ["onOff"]
  ).catch(err => { this.error(err);});
}*/

// Send the "toggle" command to cluster "onOff" on endpoint 1
/*await zclNode.endpoints[1].clusters.onOff.toggle()
  .catch(err => { this.error(err);});
*/

// Read the "onOff" attribute from the "onOff" cluster
/*const currentOnOffValue = await zclNode.endpoints[1].clusters.onOff.readAttributes(["onOff"]).catch(err => { this.error(err); });
console.log("Init OnOff : ",currentOnOffValue)*/

/*this.registerCapabilityListener("onoff", async (OnOffValue) => {
  await zclNode.endpoints[1].clusters.onOff.toggle()
  .catch(err => { this.error(err);});
});*/

// This maps the `onoff` capability to the "onOff" cluster
//this.registerCapability("onoff", CLUSTER.ON_OFF);


